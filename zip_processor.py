import os
import re
import json
import shutil
import zipfile
import tempfile
import time
import base64
import threading
import requests
from datetime import datetime, timedelta
from urllib.parse import quote

ZIP_STORAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'zip_storage')
REGISTRY_FILE = os.path.join(ZIP_STORAGE_DIR, 'registry.json')
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tax_config.json')
VALID_PLATFORMS = ['AJIO', 'MYNTRA', 'FLIPKART']
ZIP_EXPIRY_HOURS = float(os.environ.get('ZIP_EXPIRY_HOURS', 9.0))
_last_cleanup_timestamp = 0.0

def get_drive_config():
    """
    Loads Google Drive & GAS Web App settings from tax_config.json or environment
    """
    cfg = {
        'folder_id': os.environ.get('TAX_DRIVE_FOLDER_ID', '1aFmrWvPx-0QHkIkhieB-a9F2r9Zi8OOu'),
        'gas_url': os.environ.get('TAX_DRIVE_GAS_URL', ''),
        'enabled': True
    }
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                cfg.update(data)
        except Exception:
            pass

    env_fid = os.environ.get('TAX_DRIVE_FOLDER_ID') or os.environ.get('DRIVE_FOLDER_ID') or os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
    if env_fid:
        cfg['folder_id'] = env_fid.strip()

    env_gas = os.environ.get('TAX_DRIVE_GAS_URL') or os.environ.get('GOOGLE_APPS_SCRIPT_URL') or os.environ.get('GAS_URL')
    if env_gas:
        cfg['gas_url'] = env_gas.strip()

    return cfg

def sync_upload_file_to_drive(platform, party_code, category, filename, local_path):
    """
    Uploads an individual extracted file to Google Drive under ZIP_STORAGE folder
    """
    cfg = get_drive_config()
    if not cfg.get('enabled') or not cfg.get('gas_url'):
        return None
    try:
        if not os.path.exists(local_path):
            return None
        with open(local_path, 'rb') as f:
            b64_content = base64.b64encode(f.read()).decode('utf-8')
        mimetype = 'text/csv' if filename.lower().endswith('.csv') else (
            'application/pdf' if filename.lower().endswith('.pdf') else
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        payload = {
            'action': 'zip_upload_file',
            'platform': platform,
            'party_code': str(party_code),
            'category': category,
            'filename': filename,
            'content': b64_content,
            'mimetype': mimetype,
            'root_folder_id': cfg.get('folder_id')
        }
        res = requests.post(cfg['gas_url'], json=payload, timeout=60)
        return res.json()
    except Exception as e:
        print(f"Error syncing {filename} to Google Drive: {e}")
        return None

def sync_registry_to_drive(registry_data):
    """
    Saves the entire ZIP registry to Google Drive for persistent sleep-recovery
    """
    cfg = get_drive_config()
    if not cfg.get('enabled') or not cfg.get('gas_url'):
        return None
    try:
        payload = {
            'action': 'zip_save_registry',
            'registry': registry_data,
            'root_folder_id': cfg.get('folder_id')
        }
        res = requests.post(cfg['gas_url'], json=payload, timeout=30)
        return res.json()
    except Exception as e:
        print(f"Error syncing registry to Google Drive: {e}")
        return None

def restore_registry_from_drive():
    """
    Restores the ZIP registry from Google Drive when server wakes up from sleep
    """
    cfg = get_drive_config()
    if not cfg.get('enabled') or not cfg.get('gas_url'):
        return None
    try:
        payload = {
            'action': 'zip_get_registry',
            'root_folder_id': cfg.get('folder_id')
        }
        res = requests.post(cfg['gas_url'], json=payload, timeout=25)
        resp_data = res.json()
        if resp_data.get('success') and resp_data.get('registry'):
            reg = resp_data['registry']
            if isinstance(reg, dict) and 'platforms' in reg:
                # Save locally so subsequent calls are fast
                save_registry(reg, sync_to_drive=False)
                return reg
    except Exception as e:
        print(f"Note: Could not restore registry from Drive: {e}")
    return None

def download_file_from_drive(platform, party_code, category, filename, save_path):
    """
    Downloads a single file from Google Drive if missing on local disk after server sleep
    """
    cfg = get_drive_config()
    if not cfg.get('enabled') or not cfg.get('gas_url'):
        return False
    try:
        payload = {
            'action': 'zip_download_file',
            'platform': platform,
            'party_code': str(party_code),
            'category': category,
            'filename': filename,
            'root_folder_id': cfg.get('folder_id')
        }
        res = requests.post(cfg['gas_url'], json=payload, timeout=60)
        resp = res.json()
        if resp.get('success') and resp.get('content'):
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            raw = base64.b64decode(resp['content'])
            with open(save_path, 'wb') as f:
                f.write(raw)
            return True
    except Exception as e:
        print(f"Error downloading {filename} from Google Drive: {e}")
    return False

def ensure_file_on_disk(platform, party_code, category, filename):
    """
    Guarantees the file exists on local disk, pulling from Drive on-demand if server restarted
    """
    p = normalize_platform(platform)
    party_code = str(party_code).strip()
    safe_file = os.path.basename(filename)
    target_path = os.path.join(ZIP_STORAGE_DIR, p, party_code, category, safe_file)

    if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
        return target_path

    # Attempt download from Google Drive
    success = download_file_from_drive(p, party_code, category, safe_file, target_path)
    if success and os.path.exists(target_path):
        return target_path
    return None

def sync_clear_storage_on_drive(platform=None):
    """
    Clears ZIP storage on Google Drive
    """
    cfg = get_drive_config()
    if not cfg.get('enabled') or not cfg.get('gas_url'):
        return None
    try:
        payload = {
            'action': 'zip_clear_storage',
            'platform': platform or 'ALL',
            'root_folder_id': cfg.get('folder_id')
        }
        res = requests.post(cfg['gas_url'], json=payload, timeout=30)
        return res.json()
    except Exception as e:
        print(f"Error clearing ZIP storage on Google Drive: {e}")
        return None

def trigger_drive_zip_cleanup():
    """
    Triggers Google Drive 9-hour expired zip cleanup via GAS
    """
    cfg = get_drive_config()
    if not cfg.get('enabled') or not cfg.get('gas_url'):
        return None
    try:
        payload = {
            'action': 'cleanup_expired_zip',
            'root_folder_id': cfg.get('folder_id')
        }
        res = requests.post(cfg['gas_url'], json=payload, timeout=30)
        return res.json()
    except Exception as e:
        return None

def background_sync_to_drive(files_to_sync, registry_snapshot):
    """
    Uploads files and updated registry to Google Drive asynchronously
    so user UI remains ultra-fast without delay!
    """
    def _worker():
        for item in files_to_sync:
            sync_upload_file_to_drive(
                platform=item['platform'],
                party_code=item['party_code'],
                category=item['category'],
                filename=item['filename'],
                local_path=item['path']
            )
        sync_registry_to_drive(registry_snapshot)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()

def sync_all_from_drive():
    """
    Forces a fresh sync of the ZIP registry from Google Drive
    """
    restored = restore_registry_from_drive()
    if restored:
        return {'success': True, 'message': 'Successfully synced ZIP registry from Google Drive', 'data': get_all_zip_status()}
    return {'success': False, 'message': 'No active ZIP registry found on Google Drive or sync disabled'}

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

def load_registry(auto_restore=True):
    init_zip_storage()
    try:
        with open(REGISTRY_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if 'platforms' not in data:
                data['platforms'] = {}
            for p in VALID_PLATFORMS:
                if p not in data['platforms']:
                    data['platforms'][p] = {'parties': {}, 'stats': {'order_zips': 0, 'details_zips': 0, 'summary_zips': 0}}
            
            # If local registry has 0 parties (e.g. server restarted or woke from sleep)
            has_parties = any(bool(data['platforms'][p].get('parties')) for p in VALID_PLATFORMS)
            if not has_parties and auto_restore:
                restored = restore_registry_from_drive()
                if restored:
                    return restored

            return data
    except Exception as e:
        print(f"Error loading registry: {e}")
        if auto_restore:
            restored = restore_registry_from_drive()
            if restored:
                return restored
        return {
            'last_updated': datetime.now().isoformat(),
            'platforms': {p: {'parties': {}, 'stats': {'order_zips': 0, 'details_zips': 0, 'summary_zips': 0}} for p in VALID_PLATFORMS}
        }

def save_registry(registry_data, sync_to_drive=False):
    init_zip_storage()
    registry_data['last_updated'] = datetime.now().isoformat()
    temp_file = REGISTRY_FILE + '.tmp'
    with open(temp_file, 'w', encoding='utf-8') as f:
        json.dump(registry_data, f, indent=2)
    shutil.move(temp_file, REGISTRY_FILE)
    if sync_to_drive:
        sync_registry_to_drive(registry_data)

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
    files_to_sync = []

    for party_code, pfiles in extracted_parties.items():
        party_storage_dir = os.path.join(ZIP_STORAGE_DIR, platform, party_code)
        # Always create all 4 standard subfolders: od, details, summary, two_more_invoice
        order_dir = os.path.join(party_storage_dir, 'od')
        two_more_dir = os.path.join(party_storage_dir, 'two_more_invoice')
        details_dir = os.path.join(party_storage_dir, 'details')
        summary_dir = os.path.join(party_storage_dir, 'summary')
        os.makedirs(order_dir, exist_ok=True)
        os.makedirs(two_more_dir, exist_ok=True)
        os.makedirs(details_dir, exist_ok=True)
        os.makedirs(summary_dir, exist_ok=True)

        now = datetime.now()
        now_iso = now.isoformat()
        expires_dt = now + timedelta(hours=ZIP_EXPIRY_HOURS)
        expires_iso = expires_dt.isoformat()

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
                'uploaded_at': now_iso,
                'updated_at': now_iso,
                'expires_at': expires_iso,
                'expiry_hours': ZIP_EXPIRY_HOURS
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
            files_to_sync.append({
                'platform': platform,
                'party_code': party_code,
                'category': 'od',
                'filename': ord_fname,
                'path': ord_dst
            })
            
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
            files_to_sync.append({
                'platform': platform,
                'party_code': party_code,
                'category': 'two_more_invoice',
                'filename': tm_fname,
                'path': tm_dst
            })

        party_entry['uploaded_at'] = party_entry.get('uploaded_at') or now_iso
        party_entry['updated_at'] = now_iso
        party_entry['expires_at'] = expires_iso
        party_entry['expiry_hours'] = ZIP_EXPIRY_HOURS
        try:
            os.utime(party_storage_dir, None)
        except Exception:
            pass
        parties_updated.append(party_code)

    p_data['stats']['order_zips'] = p_data['stats'].get('order_zips', 0) + 1
    p_data['last_uploaded_at'] = datetime.now().isoformat()
    p_data['expires_at'] = (datetime.now() + timedelta(hours=ZIP_EXPIRY_HOURS)).isoformat()
    save_registry(registry)
    if files_to_sync:
        background_sync_to_drive(files_to_sync, registry)
    
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
    files_to_sync = []
    
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
            # Always ensure all 4 standard folders exist
            for sub in ['od', 'details', 'summary', 'two_more_invoice']:
                os.makedirs(os.path.join(party_storage_dir, sub), exist_ok=True)
            target_subfolder = os.path.join(party_storage_dir, zip_type)
            
            target_dst = os.path.join(target_subfolder, fname)
            shutil.copy2(file_path, target_dst)
            
            now = datetime.now()
            now_iso = now.isoformat()
            expires_dt = now + timedelta(hours=ZIP_EXPIRY_HOURS)
            expires_iso = expires_dt.isoformat()

            if party_code not in p_data['parties']:
                p_data['parties'][party_code] = {
                    'party_code': party_code,
                    'party_name': party_name,
                    'platform': platform,
                    'od_file': None,
                    'two_more_invoice': None,
                    'details_file': None,
                    'summary_file': None,
                    'uploaded_at': now_iso,
                    'updated_at': now_iso,
                    'expires_at': expires_iso,
                    'expiry_hours': ZIP_EXPIRY_HOURS
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

            party_entry['uploaded_at'] = party_entry.get('uploaded_at') or now_iso
            party_entry['updated_at'] = now_iso
            party_entry['expires_at'] = expires_iso
            party_entry['expiry_hours'] = ZIP_EXPIRY_HOURS
            try:
                os.utime(party_storage_dir, None)
            except Exception:
                pass
            saved_count += 1
            files_to_sync.append({
                'platform': platform,
                'party_code': party_code,
                'category': zip_type,
                'filename': fname,
                'path': target_dst
            })
            if party_code not in parties_updated:
                parties_updated.append(party_code)

    stat_key = f"{zip_type}_zips"
    p_data['stats'][stat_key] = p_data['stats'].get(stat_key, 0) + 1
    p_data['last_uploaded_at'] = datetime.now().isoformat()
    p_data['expires_at'] = (datetime.now() + timedelta(hours=ZIP_EXPIRY_HOURS)).isoformat()
    save_registry(registry)
    if files_to_sync:
        background_sync_to_drive(files_to_sync, registry)
    
    return {
        'success': True,
        'platform': platform,
        'zip_type': zip_type,
        'files_saved': saved_count,
        'parties_updated': sorted(parties_updated, key=sort_party_key),
        'message': f"Successfully processed {saved_count} {zip_type} file(s) for {platform} across {len(parties_updated)} parties!"
    }

def detect_platform_from_zip_contents(zip_filename, extract_dir, default_platform='AJIO'):
    """
    Intelligently auto-detects whether the ZIP belongs to AJIO, MYNTRA, or FLIPKART:
    1. Checks the ZIP filename (e.g. 'ajio_...', 'myntra_...', 'flipkart_...', 'fk_...')
    2. Inspects inner filenames for keywords (AJIO, MYNTRA, FLIPKART)
    3. Inspects order invoice prefixes (AJ27S -> AJIO, MY27S -> MYNTRA, FK27S -> FLIPKART)
    4. Falls back to default_platform if no platform pattern is found
    """
    z_lower = (zip_filename or '').lower()
    if 'myntra' in z_lower or 'myn' in z_lower:
        return 'MYNTRA'
    if 'flipkart' in z_lower or 'flip' in z_lower or 'fk' in z_lower:
        return 'FLIPKART'
    if 'ajio' in z_lower:
        return 'AJIO'

    ajio_votes = 0
    myntra_votes = 0
    flipkart_votes = 0

    for root, dirs, files in os.walk(extract_dir):
        if '__MACOSX' in root:
            continue
        for fname in files:
            fn_upper = fname.upper()
            if 'MYNTRA' in fn_upper or re.search(r'\bMY27S', fn_upper) or re.search(r'[-_]MY[-_]', fn_upper):
                myntra_votes += 1
            elif 'FLIPKART' in fn_upper or re.search(r'\bFK27S', fn_upper) or re.search(r'[-_]FK[-_]', fn_upper):
                flipkart_votes += 1
            elif 'AJIO' in fn_upper or re.search(r'\bAJ27S', fn_upper) or re.search(r'[-_]AJ[-_]', fn_upper):
                ajio_votes += 1

    if myntra_votes > ajio_votes and myntra_votes > flipkart_votes:
        return 'MYNTRA'
    if flipkart_votes > ajio_votes and flipkart_votes > myntra_votes:
        return 'FLIPKART'
    if ajio_votes > 0:
        return 'AJIO'

    return normalize_platform(default_platform)

def handle_zip_upload(platform, zip_type, file_storage):
    """
    Main dispatcher for uploaded ZIP files with automatic platform bifurcation
    """
    clean_expired_zip_data()
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

        # Auto-bifurcate platform based on ZIP contents and filename
        platform = detect_platform_from_zip_contents(file_storage.filename, extract_dir, default_platform=platform)
            
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
    if not result['has_od'] and party_info and party_info.get('od_file'):
        m = party_info['od_file']
        fn = m.get('filename')
        if fn:
            result['has_od'] = True
            result['od_file'] = {
                'filename': fn,
                'path': os.path.join(od_dir, fn),
                'download_url': f"/api/zip/download/{platform}/{party_code}/od/{quote(fn)}",
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
    if not result['has_pr'] and party_info and party_info.get('pr_file'):
        m = party_info['pr_file']
        fn = m.get('filename')
        if fn:
            result['has_pr'] = True
            result['pr_file'] = {
                'filename': fn,
                'path': os.path.join(pr_dir, fn),
                'download_url': f"/api/zip/download/{platform}/{party_code}/pr/{quote(fn)}",
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
    if not result['has_two_more_invoice'] and party_info and party_info.get('two_more_invoice'):
        m = party_info['two_more_invoice']
        fn = m.get('filename')
        if fn:
            result['has_two_more_invoice'] = True
            result['two_more_invoice'] = {
                'filename': fn,
                'path': os.path.join(tm_dir, fn),
                'download_url': f"/api/zip/download/{platform}/{party_code}/two_more_invoice/{quote(fn)}"
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
    if not result['has_details'] and party_info and party_info.get('details_file'):
        m = party_info['details_file']
        fn = m.get('filename')
        if fn:
            result['has_details'] = True
            result['details_file'] = {
                'filename': fn,
                'path': os.path.join(dt_dir, fn),
                'download_url': f"/api/zip/download/{platform}/{party_code}/details/{quote(fn)}"
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
    if not result['has_summary'] and party_info and party_info.get('summary_file'):
        m = party_info['summary_file']
        fn = m.get('filename')
        if fn:
            result['has_summary'] = True
            result['summary_file'] = {
                'filename': fn,
                'path': os.path.join(sm_dir, fn),
                'download_url': f"/api/zip/download/{platform}/{party_code}/summary/{quote(fn)}"
            }

    result['uploaded_at'] = party_info.get('uploaded_at', '') if party_info else ''
    result['updated_at'] = party_info.get('updated_at', '') if party_info else ''
    result['expires_at'] = party_info.get('expires_at', '') if party_info else ''
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
    Packages all available files of a party into a single downloadable .zip,
    ensuring files are restored from Google Drive if local disk was wiped.
    """
    bundle = get_party_bundle(platform, party_code)

    def _ensure(category, f_info):
        if not f_info:
            return None
        local_p = f_info.get('path')
        if not local_p or not os.path.exists(local_p):
            local_p = ensure_file_on_disk(platform, party_code, category, f_info.get('filename'))
        return local_p

    with zipfile.ZipFile(output_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        if bundle['has_order_file'] and bundle['order_file']:
            cat = 'od' if bundle.get('has_od') else 'pr'
            f_path = _ensure(cat, bundle['order_file'])
            if f_path and os.path.exists(f_path):
                prefix = bundle.get('order_file_type', 'OD')
                zf.write(f_path, arcname=f"{prefix}_{bundle['order_file']['filename']}")
        if bundle['has_two_more_invoice'] and bundle['two_more_invoice']:
            f_path = _ensure('two_more_invoice', bundle['two_more_invoice'])
            if f_path and os.path.exists(f_path):
                zf.write(f_path, arcname=f"2MORE_{bundle['two_more_invoice']['filename']}")
        if bundle['has_details'] and bundle['details_file']:
            f_path = _ensure('details', bundle['details_file'])
            if f_path and os.path.exists(f_path):
                zf.write(f_path, arcname=f"DETAILS_{bundle['details_file']['filename']}")
        if bundle['has_summary'] and bundle['summary_file']:
            f_path = _ensure('summary', bundle['summary_file'])
            if f_path and os.path.exists(f_path):
                zf.write(f_path, arcname=f"SUMMARY_{bundle['summary_file']['filename']}")

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
    Clears zip storage locally and on Google Drive with safety backup
    """
    init_zip_storage()
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_zip = os.path.join(os.path.dirname(ZIP_STORAGE_DIR), 'backups', f"zip_storage_backup_{timestamp}.zip")
    
    try:
        shutil.make_archive(backup_zip.replace('.zip', ''), 'zip', ZIP_STORAGE_DIR)
    except Exception as e:
        print(f"Error making backup of zip storage: {e}")

    if platform and str(platform).strip().upper() != 'ALL':
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

    # Clear Google Drive persistent storage as well
    sync_clear_storage_on_drive(platform)
        
    return True

def clean_expired_zip_data(expiry_hours=None, force=False):
    """
    Cleans up any party folders and registry entries ONLY when full 9 hours have elapsed
    since upload/update.
    Protects all data from being deleted on server startup or when waking up from sleep mode.
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

        for party_code, pentry in list(parties.items()):
            party_dir = os.path.join(ZIP_STORAGE_DIR, platform, party_code)
            is_expired = False
            has_timestamp = False
            
            # Check explicit expires_at
            expires_at_str = pentry.get('expires_at')
            if expires_at_str:
                has_timestamp = True
                try:
                    exp_dt = datetime.fromisoformat(expires_at_str)
                    if now_dt >= exp_dt:
                        is_expired = True
                    else:
                        # NOT EXPIRED: within 9 hours! Keep strictly intact!
                        is_expired = False
                        continue
                except Exception:
                    pass

            # Check updated_at or uploaded_at
            updated_at_str = pentry.get('updated_at') or pentry.get('uploaded_at')
            if updated_at_str:
                has_timestamp = True
                try:
                    dt = datetime.fromisoformat(updated_at_str)
                    elapsed_seconds = (now_dt - dt).total_seconds()
                    if elapsed_seconds >= expiry_seconds:
                        is_expired = True
                    else:
                        # NOT EXPIRED: within 9 hours! Keep strictly intact!
                        is_expired = False
                        continue
                except Exception:
                    pass

            # Fallback ONLY if no timestamp exists in registry entry
            if not has_timestamp and os.path.exists(party_dir):
                try:
                    dir_mtime = os.path.getmtime(party_dir)
                    if (now_ts - dir_mtime) >= expiry_seconds:
                        is_expired = True
                except Exception:
                    pass

            if is_expired:
                parties_to_delete.add(party_code)

        # For orphaned folders on disk not present in registry:
        platform_dir = os.path.join(ZIP_STORAGE_DIR, platform)
        if os.path.exists(platform_dir):
            try:
                for entry_name in os.listdir(platform_dir):
                    if entry_name in parties:
                        continue
                    entry_path = os.path.join(platform_dir, entry_name)
                    if os.path.isdir(entry_path):
                        plat_up_str = p_data.get('last_uploaded_at') or p_data.get('expires_at')
                        if plat_up_str:
                            try:
                                dt = datetime.fromisoformat(plat_up_str)
                                if (now_dt - dt).total_seconds() < expiry_seconds:
                                    continue
                            except Exception:
                                pass
                        if (now_ts - os.path.getmtime(entry_path)) >= expiry_seconds:
                            parties_to_delete.add(entry_name)
            except Exception:
                pass

        # Perform deletion of truly expired parties (> 9 hours)
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
        save_registry(registry, sync_to_drive=True)

    # Trigger Google Drive cleanup in the background
    try:
        t_clean = threading.Thread(target=trigger_drive_zip_cleanup, daemon=True)
        t_clean.start()
    except Exception:
        pass

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

