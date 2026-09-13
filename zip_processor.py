import os
import re
import json
import shutil
import zipfile
import tempfile
import time
from datetime import datetime, timedelta
from urllib.parse import quote

ZIP_STORAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'zip_storage')
REGISTRY_FILE = os.path.join(ZIP_STORAGE_DIR, 'registry.json')
VALID_PLATFORMS = ['AJIO', 'MYNTRA', 'FLIPKART']
ZIP_EXPIRY_HOURS = float(os.environ.get('ZIP_EXPIRY_HOURS', 2.0))
_last_cleanup_timestamp = 0.0

def normalize_platform(platform):
    p = (platform or 'AJIO').strip().upper()
    if p in VALID_PLATFORMS:
        return p
    if 'MYN' in p:
        return 'MYNTRA'
    if 'FK' in p or 'FLIP' in p:
        return 'FLIPKART'
    return 'AJIO'

def init_zip_storage():
    os.makedirs(ZIP_STORAGE_DIR, exist_ok=True)
    for p in VALID_PLATFORMS:
        os.makedirs(os.path.join(ZIP_STORAGE_DIR, p), exist_ok=True)
    
    if not os.path.exists(REGISTRY_FILE):
        initial = {
            'last_updated': datetime.now().isoformat(),
            'platforms': {
                'AJIO': {'parties': {}, 'stats': {'order_zips': 0, 'details_zips': 0, 'summary_zips': 0}},
                'MYNTRA': {'parties': {}, 'stats': {'order_zips': 0, 'details_zips': 0, 'summary_zips': 0}},
                'FLIPKART': {'parties': {}, 'stats': {'order_zips': 0, 'details_zips': 0, 'summary_zips': 0}}
            }
        }
        with open(REGISTRY_FILE, 'w', encoding='utf-8') as f:
            json.dump(initial, f, indent=2)

def load_registry():
    init_zip_storage()
    try:
        with open(REGISTRY_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if 'platforms' not in data:
                data['platforms'] = {}
            for p in VALID_PLATFORMS:
                if p not in data['platforms']:
                    data['platforms'][p] = {'parties': {}, 'stats': {'order_zips': 0, 'details_zips': 0, 'summary_zips': 0}}
            return data
    except Exception as e:
        print(f"Error loading registry: {e}")
        return {
            'last_updated': datetime.now().isoformat(),
            'platforms': {p: {'parties': {}, 'stats': {'order_zips': 0, 'details_zips': 0, 'summary_zips': 0}} for p in VALID_PLATFORMS}
        }

def save_registry(registry_data):
    init_zip_storage()
    registry_data['last_updated'] = datetime.now().isoformat()
    temp_file = REGISTRY_FILE + '.tmp'
    with open(temp_file, 'w', encoding='utf-8') as f:
        json.dump(registry_data, f, indent=2)
    shutil.move(temp_file, REGISTRY_FILE)

def sort_party_key(x):
    s = str(x)
    return (0, int(s)) if s.isdigit() else (1, s)

def parse_party_info_from_filename(filename):
    """
    Extracts party_code and optional party_name from filenames like:
    - '127-More & More DETAILS SHEET AJIO 25-08-2026 14-49-50_01.xlsx' -> code='127', name='More & More'
    - '101-BHARVITA SUMMARY SHEET AJIO...' -> code='101', name='BHARVITA'
    - '101-AJ27S101-29337-30125-OD.xlsx' -> code='101', name=''
    """
    base = os.path.splitext(filename)[0]
    
    m1 = re.match(r'^(\d+|[A-Za-z0-9]+)[-\s_]+(.*?)(?:\s+DETAILS|\s+DETAIL|\s+SUMMARY|\s+SHEET|\.xlsx|$)', base, re.IGNORECASE)
    if m1:
        code = m1.group(1).strip()
        name = m1.group(2).strip(' -_')
        name = re.sub(r'\b(DETAILS|SUMMARY|SHEET|AJIO|MYNTRA|FLIPKART)\b.*$', '', name, flags=re.IGNORECASE).strip(' -_')
        return code, name

    m2 = re.match(r'^(\d+|[A-Za-z0-9]+)', base)
    if m2:
        return m2.group(1).strip(), ''
        
    return 'UNKNOWN', ''

def process_order_zip(platform, extract_dir, original_zip_name=''):
    """
    Processes Order / Processed ZIP:
    - For ALL platforms (AJIO, MYNTRA, FLIPKART): Scans for OD File (*-OD.xlsx or *OD*.xlsx)
    - 2 MORE INVOICE File (*2 MORE INVOICE*.xlsx) is OPTIONAL for all platforms
    - PR files are retained as backward compatibility fallback
    """
    platform = normalize_platform(platform)
    registry = load_registry()
    p_data = registry['platforms'][platform]
    
    extracted_parties = {}
    
    # Scan all files in extract_dir
    for root, dirs, files in os.walk(extract_dir):
        if '__MACOSX' in root:
            continue
            
        rel_root = os.path.relpath(root, extract_dir)
        parts = [p for p in rel_root.replace('\\', '/').split('/') if p and p != '.']
        
        # Determine party code from folder tree
        folder_party_code = None
        for p in parts:
            m = re.match(r'^(\d+|[A-Za-z0-9]+)', p)
            if m:
                cand = m.group(1)
                # Ignore non-party generic names like 'processed', 'bundle', 'order'
                if not any(k in cand.lower() for k in ['process', 'bundle', 'order', 'report', 'summary', 'detail']):
                    folder_party_code = cand
                    break

        for fname in files:
            if fname.startswith('~$') or fname.startswith('.'):
                continue
            if not fname.lower().endswith(('.xlsx', '.xls', '.csv', '.pdf')):
                continue

            file_path = os.path.join(root, fname)
            
            # Party code from folder or filename
            party_code = folder_party_code
            if not party_code:
                code_from_fn, _ = parse_party_info_from_filename(fname)
                if code_from_fn and code_from_fn != 'UNKNOWN':
                    party_code = code_from_fn
                    
            if not party_code:
                continue

            party_code = str(party_code).strip()
            if party_code not in extracted_parties:
                extracted_parties[party_code] = {
                    'order_file': None,
                    'pr_file': None,
                    'od_file': None,
                    'two_more_invoice': None,
                    'other_files': []
                }

            # Check 2 MORE INVOICE file (Optional for all platforms)
            is_two_more = bool(re.search(r'2[\s_-]*MORE[\s_-]*INVOICE', fname, re.IGNORECASE))
            
            # Check OD file (Primary for ALL platforms: AJIO, Myntra, Flipkart)
            is_od = bool(re.search(r'[-_\s]OD\.(xlsx|xls)$', fname, re.IGNORECASE) or 
                         re.search(r'OD\.(xlsx|xls)$', fname, re.IGNORECASE) or
                         (re.search(r'\bOD\b', fname, re.IGNORECASE) and not re.search(r'2[\s_-]*MORE', fname, re.IGNORECASE)))

            # Check PR file (Backward compatibility fallback)
            is_pr = bool(re.search(r'[-_\s]PR\.(xlsx|xls)$', fname, re.IGNORECASE) or 
                         re.search(r'PR\.(xlsx|xls)$', fname, re.IGNORECASE) or
                         (re.search(r'\bPR\b', fname, re.IGNORECASE) and not re.search(r'2[\s_-]*MORE', fname, re.IGNORECASE)))
            
            if is_two_more:
                extracted_parties[party_code]['two_more_invoice'] = (fname, file_path)
            elif is_od:
                extracted_parties[party_code]['order_file'] = (fname, file_path)
                extracted_parties[party_code]['od_file'] = (fname, file_path)
            elif is_pr:
                # Fallback support if an archive still contains a PR file
                if not extracted_parties[party_code]['order_file']:
                    extracted_parties[party_code]['order_file'] = (fname, file_path)
                extracted_parties[party_code]['pr_file'] = (fname, file_path)
            else:
                extracted_parties[party_code]['other_files'].append((fname, file_path))

    saved_count = 0
    two_more_count = 0
    parties_updated = []

    for party_code, pfiles in extracted_parties.items():
        party_storage_dir = os.path.join(ZIP_STORAGE_DIR, platform, party_code)
        target_subfolder_name = 'od'
        order_dir = os.path.join(party_storage_dir, target_subfolder_name)
        two_more_dir = os.path.join(party_storage_dir, 'two_more_invoice')
        os.makedirs(order_dir, exist_ok=True)
        os.makedirs(two_more_dir, exist_ok=True)

        if party_code not in p_data['parties']:
            p_data['parties'][party_code] = {
                'party_code': party_code,
                'party_name': '',
                'platform': platform,
                'order_file_type': 'OD',
                'order_file': None,
                'od_file': None,
                'pr_file': None,
                'two_more_invoice': None,
                'details_file': None,
                'summary_file': None,
                'updated_at': datetime.now().isoformat()
            }
        
        party_entry = p_data['parties'][party_code]
        party_entry['order_file_type'] = 'OD'
        
        # Save Target OD file
        target_file = pfiles['order_file'] or pfiles['od_file'] or pfiles['pr_file']
        if target_file:
            ord_fname, ord_src = target_file
            ord_dst = os.path.join(order_dir, ord_fname)
            shutil.copy2(ord_src, ord_dst)
            
            file_meta = {
                'filename': ord_fname,
                'size': os.path.getsize(ord_dst),
                'saved_at': datetime.now().isoformat(),
                'source_zip': original_zip_name,
                'type': 'OD'
            }
            party_entry['order_file'] = file_meta
            party_entry['od_file'] = file_meta
            if pfiles['pr_file'] and pfiles['pr_file'] == target_file:
                party_entry['pr_file'] = file_meta
                
            saved_count += 1
            
        # Save 2 MORE INVOICE (Optional)
        if pfiles['two_more_invoice']:
            tm_fname, tm_src = pfiles['two_more_invoice']
            tm_dst = os.path.join(two_more_dir, tm_fname)
            shutil.copy2(tm_src, tm_dst)
            party_entry['two_more_invoice'] = {
                'filename': tm_fname,
                'size': os.path.getsize(tm_dst),
                'saved_at': datetime.now().isoformat(),
                'source_zip': original_zip_name
            }
            two_more_count += 1

        party_entry['updated_at'] = datetime.now().isoformat()
        parties_updated.append(party_code)

    p_data['stats']['order_zips'] = p_data['stats'].get('order_zips', 0) + 1
    save_registry(registry)
    
    file_type_label = 'OD'
    return {
        'success': True,
        'platform': platform,
        'zip_type': 'order',
        'file_type': file_type_label,
        'parties_count': len(extracted_parties),
        'order_files_saved': saved_count,
        'two_more_invoices_saved': two_more_count,
        'two_more_invoices_skipped': len(extracted_parties) - two_more_count,
        'parties_updated': sorted(parties_updated, key=sort_party_key),
        'message': f"Successfully processed {len(extracted_parties)} parties for {platform}! ({saved_count} {file_type_label} files, {two_more_count} 2-More-Invoices saved)"
    }

def process_details_or_summary_zip(platform, zip_type, extract_dir, original_zip_name=''):
    """
    Processes Details ZIP or Summary ZIP (e.g. ajio_details_seprate_bundle.zip / ajio_summry_seprate_bundle.zip)
    """
    platform = normalize_platform(platform)
    zip_type = 'details' if 'detail' in zip_type.lower() else 'summary'
    
    registry = load_registry()
    p_data = registry['platforms'][platform]
    
    saved_count = 0
    parties_updated = []
    
    for root, dirs, files in os.walk(extract_dir):
        if '__MACOSX' in root:
            continue
            
        for fname in files:
            if fname.startswith('~$') or fname.startswith('.'):
                continue
            if not fname.lower().endswith(('.xlsx', '.xls', '.csv', '.pdf')):
                continue

            file_path = os.path.join(root, fname)
            party_code, party_name = parse_party_info_from_filename(fname)
            
            if not party_code or party_code == 'UNKNOWN':
                parent_name = os.path.basename(root)
                m = re.match(r'^(\d+|[A-Za-z0-9]+)', parent_name)
                if m:
                    party_code = m.group(1)

            if not party_code or party_code == 'UNKNOWN':
                continue

            party_code = str(party_code).strip()
            party_storage_dir = os.path.join(ZIP_STORAGE_DIR, platform, party_code)
            target_subfolder = os.path.join(party_storage_dir, zip_type)
            os.makedirs(target_subfolder, exist_ok=True)
            
            target_dst = os.path.join(target_subfolder, fname)
            shutil.copy2(file_path, target_dst)
            
            if party_code not in p_data['parties']:
                p_data['parties'][party_code] = {
                    'party_code': party_code,
                    'party_name': party_name,
                    'platform': platform,
                    'od_file': None,
                    'two_more_invoice': None,
                    'details_file': None,
                    'summary_file': None,
                    'updated_at': datetime.now().isoformat()
                }
            
            party_entry = p_data['parties'][party_code]
            if party_name and not party_entry.get('party_name'):
                party_entry['party_name'] = party_name

            file_meta = {
                'filename': fname,
                'size': os.path.getsize(target_dst),
                'saved_at': datetime.now().isoformat(),
                'source_zip': original_zip_name
            }

            if zip_type == 'details':
                party_entry['details_file'] = file_meta
            else:
                party_entry['summary_file'] = file_meta

            party_entry['updated_at'] = datetime.now().isoformat()
            saved_count += 1
            if party_code not in parties_updated:
                parties_updated.append(party_code)

    stat_key = f"{zip_type}_zips"
    p_data['stats'][stat_key] = p_data['stats'].get(stat_key, 0) + 1
    save_registry(registry)
    
    return {
        'success': True,
        'platform': platform,
        'zip_type': zip_type,
        'files_saved': saved_count,
        'parties_updated': sorted(parties_updated, key=sort_party_key),
        'message': f"Successfully processed {saved_count} {zip_type} file(s) for {platform} across {len(parties_updated)} parties!"
    }

def handle_zip_upload(platform, zip_type, file_storage):
    """
    Main dispatcher for uploaded ZIP files
    """
    clean_expired_zip_data()
    platform = normalize_platform(platform)
    zip_type_clean = zip_type.strip().lower()
    
    with tempfile.TemporaryDirectory() as tmp_dir:
        temp_zip_path = os.path.join(tmp_dir, file_storage.filename)
        file_storage.save(temp_zip_path)
        
        extract_dir = os.path.join(tmp_dir, 'extracted')
        os.makedirs(extract_dir, exist_ok=True)
        
        try:
            with zipfile.ZipFile(temp_zip_path, 'r') as zf:
                zf.extractall(extract_dir)
        except Exception as e:
            return {'success': False, 'error': f"Failed to extract ZIP: {str(e)}"}
            
        if 'order' in zip_type_clean or 'od' in zip_type_clean:
            return process_order_zip(platform, extract_dir, original_zip_name=file_storage.filename)
        elif 'detail' in zip_type_clean:
            return process_details_or_summary_zip(platform, 'details', extract_dir, original_zip_name=file_storage.filename)
        elif 'sum' in zip_type_clean:
            return process_details_or_summary_zip(platform, 'summary', extract_dir, original_zip_name=file_storage.filename)
        else:
            return {'success': False, 'error': f"Unknown ZIP type: {zip_type}. Must be 'order', 'details', or 'summary'."}

def get_party_bundle(platform, party_code):
    """
    Retrieves all files for a specific party on a platform.
    Supports OD files as primary for all platforms (AJIO, Myntra, Flipkart),
    with fallback to legacy PR files if present.
    """
    clean_expired_zip_data()
    platform = normalize_platform(platform)
    party_code = str(party_code).strip()
    registry = load_registry()
    p_data = registry['platforms'].get(platform, {}).get('parties', {})
    
    party_info = p_data.get(party_code)
    party_dir = os.path.join(ZIP_STORAGE_DIR, platform, party_code)
    
    order_type_str = 'OD'
    
    result = {
        'platform': platform,
        'party_code': party_code,
        'party_name': party_info.get('party_name', '') if party_info else '',
        'order_file_type': order_type_str,
        'has_order_file': False,
        'order_file': None,
        'has_od': False,
        'od_file': None,
        'has_pr': False,
        'pr_file': None,
        'has_two_more_invoice': False,
        'two_more_invoice': None,
        'has_details': False,
        'details_file': None,
        'has_summary': False,
        'summary_file': None,
        'is_complete': False
    }

    # Check OD folder (Primary)
    od_dir = os.path.join(party_dir, 'od')
    if os.path.exists(od_dir):
        files = [f for f in os.listdir(od_dir) if not f.startswith('.')]
        if files:
            result['has_od'] = True
            result['od_file'] = {
                'filename': files[0],
                'path': os.path.join(od_dir, files[0]),
                'download_url': f"/api/zip/download/{platform}/{party_code}/od/{quote(files[0])}",
                'type': 'OD'
            }

    # Check PR folder (Fallback for legacy uploads)
    pr_dir = os.path.join(party_dir, 'pr')
    if os.path.exists(pr_dir):
        files = [f for f in os.listdir(pr_dir) if not f.startswith('.')]
        if files:
            result['has_pr'] = True
            result['pr_file'] = {
                'filename': files[0],
                'path': os.path.join(pr_dir, files[0]),
                'download_url': f"/api/zip/download/{platform}/{party_code}/pr/{quote(files[0])}",
                'type': 'PR'
            }

    # Set canonical order_file based on OD first, fallback to PR
    if result['has_od']:
        result['has_order_file'] = True
        result['order_file'] = result['od_file']
    elif result['has_pr']:
        result['has_order_file'] = True
        result['order_file'] = result['pr_file']

    # Check 2 More Invoice (Optional)
    tm_dir = os.path.join(party_dir, 'two_more_invoice')
    if os.path.exists(tm_dir):
        files = [f for f in os.listdir(tm_dir) if not f.startswith('.')]
        if files:
            result['has_two_more_invoice'] = True
            result['two_more_invoice'] = {
                'filename': files[0],
                'path': os.path.join(tm_dir, files[0]),
                'download_url': f"/api/zip/download/{platform}/{party_code}/two_more_invoice/{quote(files[0])}"
            }

    # Check Details
    dt_dir = os.path.join(party_dir, 'details')
    if os.path.exists(dt_dir):
        files = [f for f in os.listdir(dt_dir) if not f.startswith('.')]
        if files:
            result['has_details'] = True
            result['details_file'] = {
                'filename': files[0],
                'path': os.path.join(dt_dir, files[0]),
                'download_url': f"/api/zip/download/{platform}/{party_code}/details/{quote(files[0])}"
            }

    # Check Summary
    sm_dir = os.path.join(party_dir, 'summary')
    if os.path.exists(sm_dir):
        files = [f for f in os.listdir(sm_dir) if not f.startswith('.')]
        if files:
            result['has_summary'] = True
            result['summary_file'] = {
                'filename': files[0],
                'path': os.path.join(sm_dir, files[0]),
                'download_url': f"/api/zip/download/{platform}/{party_code}/summary/{quote(files[0])}"
            }

    result['is_complete'] = bool(result['has_order_file'] and result['has_details'] and result['has_summary'])
    return result

def get_all_zip_status():
    """
    Returns full status matrix across all platforms and parties
    """
    clean_expired_zip_data()
    registry = load_registry()
    out = {
        'platforms': {},
        'total_parties': 0,
        'total_order_files': 0,
        'total_od_files': 0,
        'total_pr_files': 0,
        'total_two_more_invoices': 0,
        'total_details_files': 0,
        'total_summary_files': 0
    }
    
    for p in VALID_PLATFORMS:
        p_info = registry['platforms'].get(p, {'parties': {}, 'stats': {}})
        parties_list = []
        
        for pcode, pentry in p_info.get('parties', {}).items():
            party_bundle = get_party_bundle(p, pcode)
            parties_list.append(party_bundle)
            
            if party_bundle['has_order_file']:
                out['total_order_files'] += 1
            if party_bundle['has_od']:
                out['total_od_files'] += 1
            if party_bundle['has_pr']:
                out['total_pr_files'] += 1
            if party_bundle['has_two_more_invoice']:
                out['total_two_more_invoices'] += 1
            if party_bundle['has_details']:
                out['total_details_files'] += 1
            if party_bundle['has_summary']:
                out['total_summary_files'] += 1

        p_od = sum(1 for pb in parties_list if (pb.get('has_od') or pb.get('has_order_file')))
        p_pr = sum(1 for pb in parties_list if pb.get('has_pr'))
        p_order = sum(1 for pb in parties_list if pb.get('has_order_file'))
        p_two_more = sum(1 for pb in parties_list if pb.get('has_two_more_invoice'))
        p_details = sum(1 for pb in parties_list if pb.get('has_details'))
        p_summary = sum(1 for pb in parties_list if pb.get('has_summary'))

        parties_list.sort(key=lambda x: sort_party_key(x['party_code']))
        out['platforms'][p] = {
            'stats': p_info.get('stats', {}),
            'order_file_type': 'OD',
            'parties_count': len(parties_list),
            'order_count': p_order,
            'od_count': p_od,
            'pr_count': p_pr,
            'two_more_count': p_two_more,
            'details_count': p_details,
            'summary_count': p_summary,
            'parties': parties_list
        }
        out['total_parties'] += len(parties_list)

    return out

def export_party_as_zip(platform, party_code, output_zip_path):
    """
    Packages all available files of a party into a single downloadable .zip
    """
    bundle = get_party_bundle(platform, party_code)
    with zipfile.ZipFile(output_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        if bundle['has_order_file'] and bundle['order_file']:
            prefix = bundle.get('order_file_type', 'OD')
            zf.write(bundle['order_file']['path'], arcname=f"{prefix}_{bundle['order_file']['filename']}")
        if bundle['has_two_more_invoice'] and bundle['two_more_invoice']:
            zf.write(bundle['two_more_invoice']['path'], arcname=f"2MORE_{bundle['two_more_invoice']['filename']}")
        if bundle['has_details'] and bundle['details_file']:
            zf.write(bundle['details_file']['path'], arcname=f"DETAILS_{bundle['details_file']['filename']}")
        if bundle['has_summary'] and bundle['summary_file']:
            zf.write(bundle['summary_file']['path'], arcname=f"SUMMARY_{bundle['summary_file']['filename']}")

def safe_rmtree(path):
    if not os.path.exists(path):
        return
    for root, dirs, files in os.walk(path, topdown=False):
        for name in files:
            p = os.path.join(root, name)
            try:
                os.chmod(p, 0o777)
                os.remove(p)
            except Exception:
                pass
        for name in dirs:
            p = os.path.join(root, name)
            try:
                os.chmod(p, 0o777)
                os.rmdir(p)
            except Exception:
                pass
    try:
        os.rmdir(path)
    except Exception:
        pass

def clear_zip_storage_data(platform=None):
    """
    Clears zip storage with safety backup
    """
    init_zip_storage()
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_zip = os.path.join(os.path.dirname(ZIP_STORAGE_DIR), 'backups', f"zip_storage_backup_{timestamp}.zip")
    
    try:
        shutil.make_archive(backup_zip.replace('.zip', ''), 'zip', ZIP_STORAGE_DIR)
    except Exception as e:
        print(f"Error making backup of zip storage: {e}")

    if platform:
        p = normalize_platform(platform)
        p_dir = os.path.join(ZIP_STORAGE_DIR, p)
        if os.path.exists(p_dir):
            safe_rmtree(p_dir)
            os.makedirs(p_dir, exist_ok=True)
            
        registry = load_registry()
        registry['platforms'][p] = {'parties': {}, 'stats': {'order_zips': 0, 'details_zips': 0, 'summary_zips': 0}}
        save_registry(registry)
    else:
        for p in VALID_PLATFORMS:
            p_dir = os.path.join(ZIP_STORAGE_DIR, p)
            if os.path.exists(p_dir):
                safe_rmtree(p_dir)
                os.makedirs(p_dir, exist_ok=True)
                
        registry = {
            'last_updated': datetime.now().isoformat(),
            'platforms': {p: {'parties': {}, 'stats': {'order_zips': 0, 'details_zips': 0, 'summary_zips': 0}} for p in VALID_PLATFORMS}
        }
        save_registry(registry)
        
    return True

def clean_expired_zip_data(expiry_hours=None, force=False):
    """
    Cleans up any party folders and registry entries older than expiry_hours (default 2 hours).
    Also prunes stale temporary bundle zips and old backups to stay within Render's 512MB limit.
    Optimized for zero server load with rate-limited check (cooldown of 60 seconds).
    """
    global _last_cleanup_timestamp
    now_ts = time.time()
    if not force and (now_ts - _last_cleanup_timestamp < 60):
        return {'success': True, 'skipped': True, 'reason': 'Rate limited (checked recently)'}

    _last_cleanup_timestamp = now_ts

    if expiry_hours is None:
        expiry_hours = ZIP_EXPIRY_HOURS

    expiry_seconds = float(expiry_hours) * 3600.0
    now_dt = datetime.now()
    removed_parties = []
    freed_bytes = 0

    init_zip_storage()
    registry = load_registry()
    modified = False

    # 1. Clean expired parties from registry and on-disk platform directories
    for platform in VALID_PLATFORMS:
        p_data = registry.get('platforms', {}).get(platform, {})
        parties = p_data.get('parties', {})
        parties_to_delete = set()

        # Check registered parties
        for party_code, pentry in parties.items():
            party_dir = os.path.join(ZIP_STORAGE_DIR, platform, party_code)
            is_expired = False
            
            # Check registry updated_at
            updated_at_str = pentry.get('updated_at')
            if updated_at_str:
                try:
                    dt = datetime.fromisoformat(updated_at_str)
                    if (now_dt - dt).total_seconds() > expiry_seconds:
                        is_expired = True
                except Exception:
                    pass

            # If no valid updated_at or still active, check folder mtime
            if not is_expired and os.path.exists(party_dir):
                try:
                    dir_mtime = os.path.getmtime(party_dir)
                    if (now_ts - dir_mtime) > expiry_seconds:
                        is_expired = True
                except Exception:
                    pass

            if is_expired:
                parties_to_delete.add(party_code)

        # Also check for orphaned party folders not in registry that are older than expiry
        platform_dir = os.path.join(ZIP_STORAGE_DIR, platform)
        if os.path.exists(platform_dir):
            try:
                for entry_name in os.listdir(platform_dir):
                    entry_path = os.path.join(platform_dir, entry_name)
                    if os.path.isdir(entry_path):
                        if (now_ts - os.path.getmtime(entry_path)) > expiry_seconds:
                            parties_to_delete.add(entry_name)
            except Exception:
                pass

        # Perform deletion
        for pcode in parties_to_delete:
            party_dir = os.path.join(ZIP_STORAGE_DIR, platform, pcode)
            if os.path.exists(party_dir):
                try:
                    for root, _, files in os.walk(party_dir):
                        for f in files:
                            freed_bytes += os.path.getsize(os.path.join(root, f))
                except Exception:
                    pass
                safe_rmtree(party_dir)

            if pcode in parties:
                parties.pop(pcode, None)
                modified = True

            removed_parties.append(f"{platform}:{pcode}")

    if modified:
        save_registry(registry)

    # 2. Clean temporary exported bundles (*_bundle.zip) in ZIP_STORAGE_DIR older than 15 minutes
    try:
        if os.path.exists(ZIP_STORAGE_DIR):
            for fname in os.listdir(ZIP_STORAGE_DIR):
                if fname.endswith('.zip'):
                    fpath = os.path.join(ZIP_STORAGE_DIR, fname)
                    if os.path.isfile(fpath):
                        if (now_ts - os.path.getmtime(fpath)) > 900:  # 15 minutes
                            try:
                                freed_bytes += os.path.getsize(fpath)
                                os.remove(fpath)
                            except Exception:
                                pass
    except Exception as e:
        print(f"Error cleaning temp zip bundles: {e}")

    # 3. Clean old backup archives in backups/ older than expiry_seconds (keeps 512MB disk safe)
    try:
        backup_dir = os.path.join(os.path.dirname(ZIP_STORAGE_DIR), 'backups')
        if os.path.exists(backup_dir):
            for fname in os.listdir(backup_dir):
                if fname.startswith('zip_storage_backup_') and fname.endswith('.zip'):
                    fpath = os.path.join(backup_dir, fname)
                    if os.path.isfile(fpath):
                        if (now_ts - os.path.getmtime(fpath)) > expiry_seconds:
                            try:
                                freed_bytes += os.path.getsize(fpath)
                                os.remove(fpath)
                            except Exception:
                                pass
    except Exception as e:
        print(f"Error cleaning old backup files: {e}")

    return {
        'success': True,
        'expiry_hours': expiry_hours,
        'removed_count': len(removed_parties),
        'removed_parties': removed_parties,
        'freed_bytes': freed_bytes
    }

