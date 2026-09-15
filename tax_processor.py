"""
tax_processor.py
================
Core business logic for Tax Report Processing, Renaming, Local Storage,
Rolling 3-Month Lifecycle, and Google Drive Synchronization.
"""

import os
import re
import shutil
import stat
import subprocess
import json
import zipfile
from datetime import datetime
import openpyxl
import csv
import base64
import requests

# Optional Google Drive API imports
try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    GDRIVE_LIBS_AVAILABLE = True
except ImportError:
    GDRIVE_LIBS_AVAILABLE = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TAX_STORAGE_DIR = os.path.join(BASE_DIR, 'tax_reports')
CONFIG_FILE = os.path.join(BASE_DIR, 'tax_config.json')

VALID_PLATFORMS = ['AJIO', 'MYNTRA', 'FLIPKART']
PLATFORM_SUFFIX = {
    'AJIO': 'A',
    'MYNTRA': 'M',
    'FLIPKART': 'F'
}

MONTH_ORDER = [
    'jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
]

# -------------------------------------------------------------------------
# Configuration Helpers
# -------------------------------------------------------------------------

def load_tax_config():
    default_cfg = {
        'folder_id': os.environ.get('TAX_DRIVE_FOLDER_ID', '1aFmrWvPx-0QHkIkhieB-a9F2r9Zi8OOu'),
        'gas_url': os.environ.get('TAX_DRIVE_GAS_URL', ''),
        'enabled': True,
        'last_sync': None
    }
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                default_cfg.update(data)
        except Exception:
            pass

    # Environment variables take top priority (ideal for Render deployment)
    env_folder_id = os.environ.get('TAX_DRIVE_FOLDER_ID') or os.environ.get('DRIVE_FOLDER_ID') or os.environ.get('GOOGLE_DRIVE_FOLDER_ID')
    if env_folder_id:
        default_cfg['folder_id'] = env_folder_id.strip()

    env_gas_url = os.environ.get('TAX_DRIVE_GAS_URL') or os.environ.get('GOOGLE_APPS_SCRIPT_URL') or os.environ.get('GAS_URL')
    if env_gas_url:
        default_cfg['gas_url'] = env_gas_url.strip()

    return default_cfg

def save_tax_config(cfg):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)
    return True

# -------------------------------------------------------------------------
# Google Drive Sync Manifest (Tracks Red vs Green per-file status)
# -------------------------------------------------------------------------

SYNC_MANIFEST_FILE = os.path.join(TAX_STORAGE_DIR, 'tax_sync_manifest.json')

def load_sync_manifest():
    if os.path.exists(SYNC_MANIFEST_FILE):
        try:
            with open(SYNC_MANIFEST_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_sync_manifest(manifest):
    try:
        os.makedirs(TAX_STORAGE_DIR, exist_ok=True)
        with open(SYNC_MANIFEST_FILE, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2)
    except Exception as e:
        print(f"Error saving sync manifest: {e}")

def get_file_sync_key(platform, month, filename, is_old=False):
    p = normalize_platform(platform)
    m = normalize_month(month)
    if is_old:
        return f"{p}/{m}/old/{filename}"
    return f"{p}/{m}/{filename}"

def mark_file_synced(platform, month, filename, drive_file_id=None, is_old=False, party_code=None):
    manifest = load_sync_manifest()
    key = get_file_sync_key(platform, month, filename, is_old=is_old)
    existing = manifest.get(key, {})
    manifest[key] = {
        'synced': True,
        'synced_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'drive_file_id': drive_file_id or existing.get('drive_file_id', ''),
        'party_code': party_code or existing.get('party_code', '')
    }
    save_sync_manifest(manifest)

def mark_file_unsynced(platform, month, filename, is_old=False, party_code=None):
    manifest = load_sync_manifest()
    key = get_file_sync_key(platform, month, filename, is_old=is_old)
    existing = manifest.get(key, {})
    manifest[key] = {
        'synced': False,
        'synced_at': None,
        'drive_file_id': '',
        'party_code': party_code or existing.get('party_code', '')
    }
    save_sync_manifest(manifest)

def is_file_synced(platform, month, filename, is_old=False, manifest=None):
    if manifest is None:
        manifest = load_sync_manifest()
    key = get_file_sync_key(platform, month, filename, is_old=is_old)
    rec = manifest.get(key)
    return bool(rec and rec.get('synced'))

def remove_from_sync_manifest(platform, month, filename=None, is_old=False):
    manifest = load_sync_manifest()
    p = normalize_platform(platform)
    m = normalize_month(month)
    if filename:
        key = get_file_sync_key(p, m, filename, is_old=is_old)
        manifest.pop(key, None)
    else:
        prefix = f"{p}/{m}/"
        keys_to_del = [k for k in list(manifest.keys()) if k.startswith(prefix)]
        for k in keys_to_del:
            manifest.pop(k, None)
    save_sync_manifest(manifest)

def rename_in_sync_manifest(platform, month, old_filename, new_filename):
    manifest = load_sync_manifest()
    old_key = get_file_sync_key(platform, month, old_filename)
    new_key = get_file_sync_key(platform, month, new_filename)
    if old_key in manifest:
        manifest[new_key] = manifest.pop(old_key)
        save_sync_manifest(manifest)

def safe_rmtree(path):
    """Safely removes a directory tree on Windows/OneDrive without permission errors."""
    if not path or not os.path.exists(path):
        return
    def _onerror(func, p, exc_info):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except Exception:
            pass
    try:
        shutil.rmtree(path, onerror=_onerror)
    except Exception:
        try:
            subprocess.run(f'cmd /c "rmdir /s /q \\"{path}\\""', shell=True, check=False)
        except Exception:
            pass

# -------------------------------------------------------------------------
# Google Apps Script Web App Integration (Zero Quota Limits)
# -------------------------------------------------------------------------

def upload_to_gas(gas_url, local_path, filename, platform, month, party_code, root_folder_id):
    if not gas_url:
        return {'success': False, 'error': 'No GAS URL configured'}
    try:
        with open(local_path, 'rb') as f:
            b64_content = base64.b64encode(f.read()).decode('utf-8')
            
        mimetype = 'text/csv' if filename.lower().endswith('.csv') else 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        payload = {
            'action': 'upload',
            'platform': platform,
            'month': month,
            'filename': filename,
            'party_code': party_code,
            'content': b64_content,
            'mimetype': mimetype,
            'root_folder_id': root_folder_id
        }
        res = requests.post(gas_url, json=payload, timeout=40)
        return res.json()
    except Exception as e:
        print(f"Error calling GAS upload ({filename}): {e}")
        return {'success': False, 'error': str(e)}

def rename_in_gas(gas_url, platform, month, old_filename, new_filename, root_folder_id):
    if not gas_url:
        return {'success': False, 'error': 'No GAS URL configured'}
    try:
        payload = {
            'action': 'rename',
            'platform': platform,
            'month': month,
            'old_filename': old_filename,
            'new_filename': new_filename,
            'root_folder_id': root_folder_id
        }
        res = requests.post(gas_url, json=payload, timeout=20)
        return res.json()
    except Exception as e:
        return {'success': False, 'error': str(e)}

def delete_in_gas(gas_url, platform, month, filename, is_old, root_folder_id):
    if not gas_url:
        return {'success': False, 'error': 'No GAS URL configured'}
    try:
        payload = {
            'action': 'delete',
            'platform': platform,
            'month': month,
            'filename': filename,
            'is_old': is_old,
            'root_folder_id': root_folder_id
        }
        res = requests.post(gas_url, json=payload, timeout=20)
        return res.json()
    except Exception as e:
        return {'success': False, 'error': str(e)}

def delete_all_in_gas(gas_url, platform, month, include_old, root_folder_id):
    if not gas_url:
        return {'success': False, 'error': 'No GAS URL configured'}
    try:
        payload = {
            'action': 'delete_all',
            'platform': platform,
            'month': month,
            'include_old': include_old,
            'root_folder_id': root_folder_id
        }
        res = requests.post(gas_url, json=payload, timeout=30)
        return res.json()
    except Exception as e:
        return {'success': False, 'error': str(e)}

def init_tax_storage():
    os.makedirs(TAX_STORAGE_DIR, exist_ok=True)
    for p in VALID_PLATFORMS:
        os.makedirs(os.path.join(TAX_STORAGE_DIR, p), exist_ok=True)

init_tax_storage()

def normalize_platform(platform):
    if not platform:
        return 'AJIO'
    p = str(platform).strip().upper()
    if 'MYNT' in p:
        return 'MYNTRA'
    if 'FLIP' in p or 'FK' in p:
        return 'FLIPKART'
    return 'AJIO'

def normalize_month(month_str):
    if not month_str:
        return datetime.now().strftime('%b').lower()
    m = str(month_str).strip().lower()
    # If full month name or date string passed, extract 3-letter month
    for short_m in MONTH_ORDER:
        if short_m in m:
            return short_m
    return m[:3]

# -------------------------------------------------------------------------
# Google Drive Engine
# -------------------------------------------------------------------------

class GoogleDriveManager:
    def __init__(self):
        self.service = None
        self.is_connected = False
        self.error_message = ""
        self.root_folder_id = ""
        self.folder_cache = {}  # path -> folder_id
        self._init_service()

    def _init_service(self):
        if not GDRIVE_LIBS_AVAILABLE:
            self.error_message = "Google Drive libraries not installed."
            return

        cfg = load_tax_config()
        self.root_folder_id = (cfg.get('folder_id') or '').strip()
        creds_path = cfg.get('credentials_path', '')

        if not creds_path or not os.path.exists(creds_path):
            self.error_message = "Service account not configured (Google Apps Script handles sync)"
            return

        try:
            creds = service_account.Credentials.from_service_account_file(
                creds_path,
                scopes=['https://www.googleapis.com/auth/drive']
            )
            self.service = build('drive', 'v3', credentials=creds, cache_discovery=False)
            
            # Verify credentials with a lightweight call
            if self.root_folder_id:
                try:
                    f = self.service.files().get(fileId=self.root_folder_id, fields='id, name').execute()
                    self.is_connected = True
                    self.error_message = ""
                except Exception as e:
                    self.error_message = f"Cannot access root folder ID: {str(e)}"
                    self.is_connected = False
            else:
                self.is_connected = True
                self.error_message = "Connected! (Enter Tax Reports Folder ID to enable auto-sync)"
        except Exception as e:
            self.error_message = f"Auth error: {str(e)}"
            self.is_connected = False

    def get_status(self):
        cfg = load_tax_config()
        creds_present = bool(cfg.get('credentials_path')) and os.path.exists(cfg.get('credentials_path', ''))
        return {
            'installed': GDRIVE_LIBS_AVAILABLE,
            'credentials_present': creds_present,
            'connected': self.is_connected and bool(self.root_folder_id),
            'root_folder_id': self.root_folder_id,
            'message': self.error_message if self.error_message else ("Drive Connected & Active" if self.is_connected else "Drive Not Connected")
        }

    def get_or_create_folder(self, folder_name, parent_id=None):
        if not self.service:
            return None
        parent = parent_id or self.root_folder_id
        if not parent:
            return None

        cache_key = f"{parent}/{folder_name}"
        if cache_key in self.folder_cache:
            return self.folder_cache[cache_key]

        try:
            # Query for existing folder
            query = f"mimeType = 'application/vnd.google-apps.folder' and name = '{folder_name}' and '{parent}' in parents and trashed = false"
            res = self.service.files().list(q=query, spaces='drive', fields='files(id, name)').execute()
            files = res.get('files', [])
            if files:
                fid = files[0]['id']
                self.folder_cache[cache_key] = fid
                return fid

            # Create folder
            meta = {
                'name': folder_name,
                'mimeType': 'application/vnd.google-apps.folder',
                'parents': [parent]
            }
            folder = self.service.files().create(body=meta, fields='id').execute()
            fid = folder.get('id')
            self.folder_cache[cache_key] = fid
            return fid
        except Exception as e:
            print(f"Error in get_or_create_folder ({folder_name}): {e}")
            return None

    def upload_file(self, local_path, filename, parent_folder_id):
        if not self.service or not parent_folder_id:
            return None
        try:
            # Check if file already exists in target folder
            query = f"name = '{filename}' and '{parent_folder_id}' in parents and trashed = false"
            res = self.service.files().list(q=query, spaces='drive', fields='files(id, name)').execute()
            files = res.get('files', [])

            mime = 'text/csv' if local_path.lower().endswith('.csv') else 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            media = MediaFileUpload(local_path, mimetype=mime, resumable=True)
            if files:
                # Update existing
                file_id = files[0]['id']
                updated = self.service.files().update(fileId=file_id, media_body=media, fields='id').execute()
                return updated.get('id')
            else:
                # Create new
                meta = {
                    'name': filename,
                    'parents': [parent_folder_id]
                }
                created = self.service.files().create(body=meta, media_body=media, fields='id').execute()
                return created.get('id')
        except Exception as e:
            print(f"Error uploading file to Drive ({filename}): {e}")
            return None

    def move_file(self, filename, from_folder_id, to_folder_id):
        if not self.service or not from_folder_id or not to_folder_id:
            return False
        try:
            query = f"name = '{filename}' and '{from_folder_id}' in parents and trashed = false"
            res = self.service.files().list(q=query, spaces='drive', fields='files(id, parents)').execute()
            files = res.get('files', [])
            if not files:
                return False
            
            file_id = files[0]['id']
            # Move file by updating parents
            self.service.files().update(
                fileId=file_id,
                addParents=to_folder_id,
                removeParents=from_folder_id,
                fields='id, parents'
            ).execute()
            return True
        except Exception as e:
            print(f"Error moving file in Drive ({filename}): {e}")
            return False

    def rename_file(self, old_filename, new_filename, parent_folder_id):
        if not self.service or not parent_folder_id:
            return False
        try:
            query = f"name = '{old_filename}' and '{parent_folder_id}' in parents and trashed = false"
            res = self.service.files().list(q=query, spaces='drive', fields='files(id)').execute()
            files = res.get('files', [])
            if not files:
                return False
            
            file_id = files[0]['id']
            self.service.files().update(fileId=file_id, body={'name': new_filename}).execute()
            return True
        except Exception as e:
            print(f"Error renaming file in Drive ({old_filename} -> {new_filename}): {e}")
            return False

    def delete_file(self, filename, parent_folder_id):
        if not self.service or not parent_folder_id:
            return False
        try:
            query = f"name = '{filename}' and '{parent_folder_id}' in parents and trashed = false"
            res = self.service.files().list(q=query, spaces='drive', fields='files(id)').execute()
            files = res.get('files', [])
            if not files:
                return False
            
            file_id = files[0]['id']
            self.service.files().delete(fileId=file_id).execute()
            return True
        except Exception as e:
            print(f"Error deleting file in Drive ({filename}): {e}")
            return False

    def delete_folder(self, folder_name, parent_folder_id):
        if not self.service or not parent_folder_id:
            return False
        try:
            query = f"mimeType = 'application/vnd.google-apps.folder' and name = '{folder_name}' and '{parent_folder_id}' in parents and trashed = false"
            res = self.service.files().list(q=query, spaces='drive', fields='files(id)').execute()
            files = res.get('files', [])
            if not files:
                return False
            
            for f in files:
                self.service.files().delete(fileId=f['id']).execute()
            return True
        except Exception as e:
            print(f"Error deleting folder in Drive ({folder_name}): {e}")
            return False

# Global Drive Manager instance
gdrive = GoogleDriveManager()

def reload_gdrive_connection():
    global gdrive
    gdrive = GoogleDriveManager()
    return gdrive.get_status()

# -------------------------------------------------------------------------
# Excel Parser & Party Code Extractor
# -------------------------------------------------------------------------

def extract_party_code(excel_path, platform):
    """
    Inspects row 2 (and early data rows) of the Excel file:
    1. Checks Column G ('EE Invoice No'):
       - Standard pattern: (MY|AJ|FK)27S<PartyCode>-...
    2. Fallback: Checks Column A ('Company Name'):
       - Non-standard series (e.g. CGJ12627-295, MY27SY02-12, AJ27SJ22-10, AJ27SJ02-336):
         Extracts leading digits/alphanumerics before '-' (e.g. '198', 'MY2', 'AJ22', 'AJ2').
    """
    platform = normalize_platform(platform)
    party_code = None

    rows = []
    wb = None

    # Check binary signature
    is_ole2_xls = False
    is_zip_xlsx = False
    try:
        with open(excel_path, 'rb') as f:
            sig = f.read(8)
            if sig.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'):
                is_ole2_xls = True
            elif sig.startswith(b'PK'):
                is_zip_xlsx = True
    except Exception:
        pass

    if is_ole2_xls or excel_path.lower().endswith('.xls'):
        try:
            import xlrd
            wb = xlrd.open_workbook(excel_path, ignore_workbook_corruption=True)
            sheet = wb.sheet_by_index(0)
            for r in range(min(60, sheet.nrows)):
                row_vals = [sheet.cell_value(r, c) for c in range(sheet.ncols)]
                rows.append(row_vals)
        except Exception as e:
            print(f"Error inspecting XLS with xlrd: {e}")
    elif is_zip_xlsx or excel_path.lower().endswith('.xlsx'):
        try:
            wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
            sheet_names = wb.sheetnames
            target_sheet = sheet_names[0]
            for s in sheet_names:
                if 'TAX' in s.upper() or 'REPORT' in s.upper():
                    target_sheet = s
                    break
            ws = wb[target_sheet]
            for idx, r in enumerate(ws.iter_rows(values_only=True)):
                if idx > 60:
                    break
                rows.append(list(r))
        except Exception as e:
            print(f"Error inspecting Excel with openpyxl: {e}")
        finally:
            if wb:
                try:
                    wb.close()
                except Exception:
                    pass
    else:
        # Plain text CSV
        for enc in ['utf-8-sig', 'utf-8', 'latin-1', 'cp1252']:
            try:
                with open(excel_path, 'r', encoding=enc, errors='replace') as f:
                    reader = csv.reader(f)
                    for idx, r in enumerate(reader):
                        if idx > 60:
                            break
                        rows.append(r)
                if rows:
                    break
            except Exception:
                continue

    # Scan rows
    header_row = None
    g_col_idx = 7  # 1-indexed default (column G)
    a_col_idx = 1  # 1-indexed default (column A)

    for row_idx, row in enumerate(rows, start=1):
        if row_idx == 1:
            header_row = [str(c).strip() if c is not None else '' for c in row]
            # Try finding Column G & A by header names
            for idx, col_val in enumerate(header_row):
                col_str = str(col_val).upper()
                if 'EE INVOICE' in col_str or 'INVOICE NO' in col_str or 'INV NO' in col_str:
                    g_col_idx = idx + 1
                elif 'COMPANY' in col_str or 'PARTY NAME' in col_str or col_str == 'PARTY':
                    a_col_idx = idx + 1
            continue

        if not row:
            continue

        # Read Column G and Column A cell values
        val_g = str(row[g_col_idx - 1]).strip() if (len(row) >= g_col_idx and row[g_col_idx - 1] is not None) else ''
        val_a = str(row[a_col_idx - 1]).strip() if (len(row) >= a_col_idx and row[a_col_idx - 1] is not None) else ''

        if not val_g and not val_a:
            continue

        # Step 1: Check Column G for standard pattern:
        # Examples: MY27S139-6271, AJ27S150-94, FK27S509-575
        m_std = re.search(r'(?:MY|AJ|FK)\d+S([A-Za-z0-9]+)-', val_g, re.IGNORECASE)
        if m_std:
            code_candidate = m_std.group(1).strip()
            # Check if it's a valid standard numeric party code (like 139, 150, 509)
            if code_candidate.isdigit():
                party_code = code_candidate
                break
            # Or if it's alphanumeric (like Y02, J22, J02) we check Column A for exact name
            else:
                if val_a:
                    m_comp = re.search(r'^([A-Za-z0-9]+)\s*[-_]', val_a)
                    if m_comp:
                        party_code = m_comp.group(1).strip()
                        break
                party_code = code_candidate
                break

        # Step 2: If Column G is non-standard (e.g. CGJ12627-295, MY27SY02-12, AJ27SJ22-10):
        # Check Column A (Company Name)
        # Examples: '198-Gufrina (Admin)', 'MY2-J Mogal (Admin)', 'AJ22-KOMZ (Admin)', 'AJ2-SOLIXON (Admin)'
        if val_a:
            m_comp = re.search(r'^([A-Za-z0-9]+)\s*[-_]', val_a)
            if m_comp:
                party_code = m_comp.group(1).strip()
                break

        # If Column G has any format with '-' (e.g. 150-94)
        m_generic = re.search(r'S(\d+)-', val_g, re.IGNORECASE)
        if m_generic:
            party_code = m_generic.group(1).strip()
            break

    # Fallback to filename if not found in cells
    if not party_code:
        fname = os.path.basename(excel_path)
        m_fn = re.search(r'^(\d+)[-_]', fname) or re.search(r'[-_](\d+)[-_]', fname)
        if m_fn:
            party_code = m_fn.group(1)
        else:
            party_code = 'UNKNOWN'

    return str(party_code).strip()


def build_renamed_filename(original_filename, party_code, platform):
    """
    Builds the renamed filename: <base_name><party_code><platform_suffix>.xlsx
    Example: TaxReportData6a96a1b92f11b.xlsx + 139 + MYNTRA -> TaxReportData6a96a1b92f11b139M.xlsx
    """
    platform = normalize_platform(platform)
    suffix = PLATFORM_SUFFIX.get(platform, 'A')
    
    base_name, ext = os.path.splitext(original_filename)
    if not ext:
        ext = '.xlsx'

    # Clean any leading party prefixes (e.g. 198-TaxReportData... -> TaxReportData...)
    cleaned_base = re.sub(r'^\d+[\s_-]+', '', base_name)
    
    # Also strip any trailing party suffix if file was already renamed previously
    cleaned_base = re.sub(r'\d+[AMF]$', '', cleaned_base, flags=re.IGNORECASE)

    renamed = f"{cleaned_base}{party_code}{suffix}{ext}"
    return renamed

# -------------------------------------------------------------------------
# Lifecycle: 3-Month Rolling Policy & Overwrite / Old Archive
# -------------------------------------------------------------------------

def enforce_rolling_3_months(platform):
    """
    Ensures maximum 3 active month folders exist for a platform.
    If 4th month arrives, automatically deletes the oldest month folder
    both locally and in Google Drive.
    """
    platform = normalize_platform(platform)
    plat_dir = os.path.join(TAX_STORAGE_DIR, platform)
    if not os.path.exists(plat_dir):
        return

    # List all subfolders that are months
    month_dirs = [d for d in os.listdir(plat_dir) if os.path.isdir(os.path.join(plat_dir, d))]
    
    if len(month_dirs) <= 3:
        return

    # Sort month folders by last modified time or month order
    def month_sort_key(m_name):
        m_clean = m_name.lower()[:3]
        if m_clean in MONTH_ORDER:
            return MONTH_ORDER.index(m_clean)
        try:
            return int(os.path.getmtime(os.path.join(plat_dir, m_name)))
        except Exception:
            return 999

    # Sort so oldest is first
    month_dirs.sort(key=lambda m: os.path.getmtime(os.path.join(plat_dir, m)))

    # Drive parent folder for platform
    drive_plat_fid = None
    if gdrive.is_connected and gdrive.root_folder_id:
        drive_plat_fid = gdrive.get_or_create_folder(platform)

    # Delete oldest until 3 remain
    while len(month_dirs) > 3:
        oldest_month = month_dirs.pop(0)
        oldest_path = os.path.join(plat_dir, oldest_month)
        try:
            shutil.rmtree(oldest_path, ignore_errors=True)
            print(f"Rolling cleanup: Deleted oldest local month folder '{oldest_month}' for {platform}")
        except Exception as e:
            print(f"Error removing local folder {oldest_path}: {e}")

        # Delete in Google Drive as well
        if drive_plat_fid:
            try:
                gdrive.delete_folder(oldest_month, drive_plat_fid)
                print(f"Rolling cleanup: Deleted Drive month folder '{oldest_month}' for {platform}")
            except Exception as e:
                print(f"Error deleting Drive folder {oldest_month}: {e}")


def handle_file_save_and_archive(platform, month, target_filename, temp_src_path, party_code):
    """
    Saves file into tax_reports/<platform>/<month>/
    If a file for the same party already exists:
    - Moves older file to tax_reports/<platform>/<month>/old/
    - Uploads/syncs to Google Drive as well
    """
    platform = normalize_platform(platform)
    month = normalize_month(month)
    suffix = PLATFORM_SUFFIX.get(platform, 'A')

    month_dir = os.path.join(TAX_STORAGE_DIR, platform, month)
    old_dir = os.path.join(month_dir, 'old')
    os.makedirs(month_dir, exist_ok=True)

    # Drive folder references
    drive_plat_fid = None
    drive_month_fid = None
    drive_old_fid = None

    if gdrive.is_connected and gdrive.root_folder_id:
        drive_plat_fid = gdrive.get_or_create_folder(platform)
        if drive_plat_fid:
            drive_month_fid = gdrive.get_or_create_folder(month, drive_plat_fid)
            if drive_month_fid:
                drive_old_fid = gdrive.get_or_create_folder('old', drive_month_fid)

    # Check for existing file with same party code in this month
    existing_files = [f for f in os.listdir(month_dir) if os.path.isfile(os.path.join(month_dir, f))]
    party_pattern = re.compile(rf'{re.escape(party_code)}{suffix}\.(xlsx|xls)$', re.IGNORECASE)

    archived_file = None
    for ef in existing_files:
        if party_pattern.search(ef):
            # Found existing file for this party -> Move to old/
            os.makedirs(old_dir, exist_ok=True)
            src_existing = os.path.join(month_dir, ef)
            dst_archived = os.path.join(old_dir, ef)

            # Avoid collision in old/ by adding timestamp if needed
            if os.path.exists(dst_archived):
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                bname, ext = os.path.splitext(ef)
                dst_archived = os.path.join(old_dir, f"{bname}_{timestamp}{ext}")

            try:
                shutil.move(src_existing, dst_archived)
                archived_file = ef
                print(f"Archived existing file for party {party_code}: {ef} -> old/")
            except Exception as e:
                print(f"Error moving file to old/: {e}")

            # Mark archived file as unsynced in old/
            mark_file_unsynced(platform, month, ef, is_old=True, party_code=party_code)

    # Now save the newly uploaded file into month_dir
    dest_path = os.path.join(month_dir, target_filename)
    shutil.copy2(temp_src_path, dest_path)

    # Mark newly uploaded file as pending sync (RED status) with its accurate party_code
    mark_file_unsynced(platform, month, target_filename, is_old=False, party_code=party_code)

    # Enforce 3-month rolling policy
    enforce_rolling_3_months(platform)

    return {
        'filename': target_filename,
        'path': dest_path,
        'party_code': party_code,
        'platform': platform,
        'month': month,
        'archived_old': archived_file,
        'gdrive_id': None,
        'gdrive_synced': False,
        'is_synced': False
    }

# -------------------------------------------------------------------------
# Public API Methods
# -------------------------------------------------------------------------

def process_tax_upload(platform, month, file_storage_list):
    """
    Main entrypoint when files are uploaded via API.
    Handles extraction, renaming, archiving, and Drive sync.
    """
    platform = normalize_platform(platform)
    month = normalize_month(month)
    results = []
    errors = []

    temp_upload_dir = os.path.join(TAX_STORAGE_DIR, '_temp_uploads')
    os.makedirs(temp_upload_dir, exist_ok=True)

    for fs in file_storage_list:
        if not fs or fs.filename == '':
            continue

        raw_name = os.path.basename(fs.filename)
        if not (raw_name.lower().endswith('.xlsx') or raw_name.lower().endswith('.xls') or raw_name.lower().endswith('.csv')):
            errors.append(f"Skipped {raw_name}: Only Excel or CSV files (.xlsx, .xls, .csv) are supported.")
            continue

        temp_path = os.path.join(temp_upload_dir, f"temp_{datetime.now().strftime('%H%M%S%f')}_{raw_name}")
        try:
            fs.save(temp_path)
            
            # 1. Extract Party Code
            party_code = extract_party_code(temp_path, platform)
            
            # 2. Build Renamed Filename
            renamed_filename = build_renamed_filename(raw_name, party_code, platform)
            
            # 3. Save into Month Folder & Archive duplicate if present
            save_res = handle_file_save_and_archive(platform, month, renamed_filename, temp_path, party_code)
            results.append({
                'original_filename': raw_name,
                'renamed_filename': renamed_filename,
                'party_code': party_code,
                'platform': platform,
                'month': month,
                'archived_old': save_res.get('archived_old'),
                'gdrive_synced': save_res.get('gdrive_synced', False)
            })
        except Exception as e:
            errors.append(f"Failed to process {raw_name}: {str(e)}")
        finally:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass

    return {
        'success': len(results) > 0,
        'platform': platform,
        'month': month,
        'processed_count': len(results),
        'uploaded_count': len(results),
        'renamed_count': len(results),
        'results': results,
        'errors': errors,
        'gdrive_status': gdrive.get_status()
    }


def get_all_tax_data():
    """
    Returns full metadata tree across all platforms, months, and files.
    """
    cfg = load_tax_config()
    gas_url = (cfg.get('gas_url') or '').strip()
    status = gdrive.get_status()
    if gas_url:
        status['gas_configured'] = True
        status['gas_url'] = gas_url
        status['connected'] = True
        status['message'] = 'Google Apps Script Drive Sync Active'

    out = {
        'platforms': {},
        'gdrive_status': status,
        'available_months': MONTH_ORDER
    }

    manifest = load_sync_manifest()
    manifest_changed = False

    for p in VALID_PLATFORMS:
        p_dir = os.path.join(TAX_STORAGE_DIR, p)
        months_data = {}
        
        if os.path.exists(p_dir):
            month_folders = [d for d in os.listdir(p_dir) if os.path.isdir(os.path.join(p_dir, d))]
            # Sort months chronologically
            month_folders.sort(key=lambda m: os.path.getmtime(os.path.join(p_dir, m)), reverse=True)
            
            for m in month_folders:
                m_path = os.path.join(p_dir, m)
                active_files = []
                old_files = []

                for entry in os.listdir(m_path):
                    fpath = os.path.join(m_path, entry)
                    if os.path.isfile(fpath) and not entry.startswith('.'):
                        sz = os.path.getsize(fpath)
                        mtime = os.path.getmtime(fpath)
                        
                        sync_key = get_file_sync_key(p, m, entry, is_old=False)
                        s_info = manifest.get(sync_key, {})
                        is_sync = bool(s_info.get('synced', False))
                        
                        # Accurately retrieve party code from manifest, or extract from file
                        pcode = s_info.get('party_code')
                        if not pcode:
                            try:
                                pcode = extract_party_code(fpath, p)
                                if pcode:
                                    s_info['party_code'] = pcode
                                    manifest[sync_key] = s_info
                                    manifest_changed = True
                            except Exception:
                                pcode = ''
                        
                        active_files.append({
                            'filename': entry,
                            'party_code': pcode,
                            'size': sz,
                            'size_str': f"{sz / 1024:.1f} KB" if sz < 1048576 else f"{sz / 1048576:.2f} MB",
                            'updated_at': datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %H:%M'),
                            'download_url': f"/api/tax/download/{p}/{m}/{entry}",
                            'is_synced': is_sync,
                            'synced_at': s_info.get('synced_at'),
                            'drive_file_id': s_info.get('drive_file_id')
                        })

                # Check old/ folder
                old_dir = os.path.join(m_path, 'old')
                if os.path.exists(old_dir):
                    for entry in os.listdir(old_dir):
                        fpath = os.path.join(old_dir, entry)
                        if os.path.isfile(fpath) and not entry.startswith('.'):
                            sz = os.path.getsize(fpath)
                            mtime = os.path.getmtime(fpath)
                            sync_key = get_file_sync_key(p, m, entry, is_old=True)
                            s_info = manifest.get(sync_key, {})
                            is_sync = bool(s_info.get('synced', False))
                            pcode = s_info.get('party_code')
                            if not pcode:
                                try:
                                    pcode = extract_party_code(fpath, p)
                                    if pcode:
                                        s_info['party_code'] = pcode
                                        manifest[sync_key] = s_info
                                        manifest_changed = True
                                except Exception:
                                    pcode = ''

                            old_files.append({
                                'filename': entry,
                                'party_code': pcode,
                                'size': sz,
                                'size_str': f"{sz / 1024:.1f} KB",
                                'archived_at': datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %H:%M'),
                                'download_url': f"/api/tax/download/{p}/{m}/old/{entry}",
                                'is_synced': is_sync,
                                'synced_at': s_info.get('synced_at'),
                                'drive_file_id': s_info.get('drive_file_id')
                            })

                synced_cnt = sum(1 for f in active_files if f['is_synced'])
                unsynced_cnt = len(active_files) - synced_cnt

                # If this month has 0 active files and 0 old files, auto-purge the empty folder and skip
                if len(active_files) == 0 and len(old_files) == 0:
                    safe_rmtree(m_path)
                    continue

                months_data[m] = {
                    'month': m,
                    'files_count': len(active_files),
                    'old_files_count': len(old_files),
                    'synced_count': synced_cnt,
                    'unsynced_count': unsynced_cnt,
                    'files': sorted(active_files, key=lambda x: x['filename']),
                    'old_files': sorted(old_files, key=lambda x: x['filename'])
                }

        # Merge any files recorded in manifest (synced to Google Drive)
        for sync_key, s_info in manifest.items():
            parts = sync_key.split('/')
            if len(parts) < 3:
                continue
            plat = normalize_platform(parts[0])
            if plat != p:
                continue
            m = normalize_month(parts[1])
            is_old = (len(parts) >= 4 and parts[2] == 'old')
            entry = parts[3] if is_old else parts[2]

            if m not in months_data:
                months_data[m] = {
                    'month': m,
                    'files_count': 0,
                    'old_files_count': 0,
                    'synced_count': 0,
                    'unsynced_count': 0,
                    'files': [],
                    'old_files': []
                }

            target_list = months_data[m]['old_files'] if is_old else months_data[m]['files']
            already_present = any(f['filename'] == entry for f in target_list)
            if not already_present:
                sz = s_info.get('size', 0)
                sz_str = s_info.get('size_str') or (f"{sz / 1024:.1f} KB" if sz > 0 else "Drive Sync")
                record = {
                    'filename': entry,
                    'party_code': s_info.get('party_code', ''),
                    'size': sz,
                    'size_str': sz_str,
                    'updated_at': s_info.get('synced_at') or 'Synced in Drive',
                    'download_url': f"/api/tax/download/{p}/{m}/{'old/' if is_old else ''}{entry}",
                    'is_synced': bool(s_info.get('synced', True)),
                    'synced_at': s_info.get('synced_at'),
                    'drive_file_id': s_info.get('drive_file_id')
                }
                target_list.append(record)
                if not is_old:
                    months_data[m]['files_count'] = len(months_data[m]['files'])
                    if record['is_synced']:
                        months_data[m]['synced_count'] += 1
                    else:
                        months_data[m]['unsynced_count'] += 1
                else:
                    months_data[m]['old_files_count'] = len(months_data[m]['old_files'])

        for m, m_obj in months_data.items():
            m_obj['files'].sort(key=lambda x: x['filename'])
            m_obj['old_files'].sort(key=lambda x: x['filename'])

        out['platforms'][p] = {
            'platform': p,
            'months': months_data,
            'active_months_count': len(months_data)
        }

    if manifest_changed:
        save_sync_manifest(manifest)

    return out


def rename_tax_file(platform, month, old_filename, new_filename):
    """
    Renames a file locally and in Google Drive. Always preserves original file extension.
    """
    platform = normalize_platform(platform)
    month = normalize_month(month)
    
    old_base, old_ext = os.path.splitext(old_filename)
    new_base, new_ext = os.path.splitext(new_filename)
    
    # Strictly preserve the original extension!
    new_filename = f"{new_base}{old_ext}"

    month_dir = os.path.join(TAX_STORAGE_DIR, platform, month)
    src = os.path.join(month_dir, old_filename)
    dst = os.path.join(month_dir, new_filename)

    if not os.path.exists(src):
        return {'success': False, 'error': f"File not found: {old_filename}"}

    if os.path.exists(dst) and src.lower() != dst.lower():
        return {'success': False, 'error': f"A file with name '{new_filename}' already exists."}

    try:
        os.rename(src, dst)
        rename_in_sync_manifest(platform, month, old_filename, new_filename)
    except Exception as e:
        return {'success': False, 'error': f"Rename error: {str(e)}"}

    # Sync rename in Drive (via GAS or Drive API)
    drive_synced = False
    cfg = load_tax_config()
    gas_url = (cfg.get('gas_url') or '').strip()
    root_id = (cfg.get('folder_id') or gdrive.root_folder_id or '').strip()

    if gas_url:
        res = rename_in_gas(gas_url, platform, month, old_filename, new_filename, root_id)
        drive_synced = bool(res.get('success'))
    elif gdrive.is_connected and gdrive.root_folder_id:
        plat_fid = gdrive.get_or_create_folder(platform)
        if plat_fid:
            month_fid = gdrive.get_or_create_folder(month, plat_fid)
            if month_fid:
                drive_synced = gdrive.rename_file(old_filename, new_filename, month_fid)

    return {
        'success': True,
        'old_filename': old_filename,
        'new_filename': new_filename,
        'gdrive_synced': drive_synced
    }


def delete_tax_file(platform, month, filename, is_old=False):
    """
    Deletes a file locally and from Google Drive.
    """
    platform = normalize_platform(platform)
    month = normalize_month(month)
    
    month_dir = os.path.join(TAX_STORAGE_DIR, platform, month)
    if is_old:
        target_dir = os.path.join(month_dir, 'old')
    else:
        target_dir = month_dir

    file_path = os.path.join(target_dir, filename)
    if not os.path.exists(file_path):
        return {'success': False, 'error': f"File not found: {filename}"}

    try:
        os.remove(file_path)
        remove_from_sync_manifest(platform, month, filename, is_old=is_old)

        # If month is now completely empty, remove month directory
        rem_active = [f for f in os.listdir(month_dir) if os.path.isfile(os.path.join(month_dir, f)) and not f.startswith('.')] if os.path.exists(month_dir) else []
        rem_old_dir = os.path.join(month_dir, 'old')
        rem_old = [f for f in os.listdir(rem_old_dir) if os.path.isfile(os.path.join(rem_old_dir, f)) and not f.startswith('.')] if os.path.exists(rem_old_dir) else []
        if len(rem_active) == 0 and len(rem_old) == 0:
            safe_rmtree(month_dir)
    except Exception as e:
        return {'success': False, 'error': f"Delete error: {str(e)}"}

    # Delete on Google Drive (via GAS or Drive API)
    drive_deleted = False
    cfg = load_tax_config()
    gas_url = (cfg.get('gas_url') or '').strip()
    root_id = (cfg.get('folder_id') or gdrive.root_folder_id or '').strip()

    if gas_url:
        res = delete_in_gas(gas_url, platform, month, filename, is_old, root_id)
        drive_deleted = bool(res.get('success'))
    elif gdrive.is_connected and gdrive.root_folder_id:
        plat_fid = gdrive.get_or_create_folder(platform)
        if plat_fid:
            month_fid = gdrive.get_or_create_folder(month, plat_fid)
            if month_fid:
                target_fid = gdrive.get_or_create_folder('old', month_fid) if is_old else month_fid
                drive_deleted = gdrive.delete_file(filename, target_fid)

    return {
        'success': True,
        'filename': filename,
        'gdrive_deleted': drive_deleted
    }


def delete_all_tax_files(platform, month, include_old=True):
    """
    Deletes all files in a platform's month folder locally and in Google Drive.
    """
    platform = normalize_platform(platform)
    month = normalize_month(month)
    month_dir = os.path.join(TAX_STORAGE_DIR, platform, month)

    if not os.path.exists(month_dir):
        return {'success': False, 'error': f"Directory not found for {platform}/{month}"}

    # Gather files before deleting locally for fallback if needed
    active_files = [f for f in os.listdir(month_dir) if os.path.isfile(os.path.join(month_dir, f)) and not f.startswith('.')]
    old_dir = os.path.join(month_dir, 'old')
    old_files = []
    if include_old and os.path.exists(old_dir):
        old_files = [f for f in os.listdir(old_dir) if os.path.isfile(os.path.join(old_dir, f)) and not f.startswith('.')]

    local_deleted = 0
    # 1. Delete active local files
    for f in active_files:
        try:
            os.remove(os.path.join(month_dir, f))
            local_deleted += 1
        except Exception as e:
            print(f"Error removing {f}: {e}")

    # 2. Delete old local files if requested
    for f in old_files:
        try:
            os.remove(os.path.join(old_dir, f))
            local_deleted += 1
        except Exception as e:
            print(f"Error removing old {f}: {e}")

    # Remove all tracking entries for this platform and month
    remove_from_sync_manifest(platform, month)
    safe_rmtree(month_dir)

    # 3. Google Drive deletion
    drive_deleted = False
    cfg = load_tax_config()
    gas_url = (cfg.get('gas_url') or '').strip()
    root_id = (cfg.get('folder_id') or gdrive.root_folder_id or '').strip()

    if gas_url:
        gas_res = delete_all_in_gas(gas_url, platform, month, include_old, root_id)
        if gas_res.get('success'):
            drive_deleted = True
        elif 'Unknown action' in str(gas_res.get('error', '')):
            # Fallback: delete files individually if GAS wasn't redeployed yet
            for f in active_files:
                delete_in_gas(gas_url, platform, month, f, is_old=False, root_folder_id=root_id)
            for f in old_files:
                delete_in_gas(gas_url, platform, month, f, is_old=True, root_folder_id=root_id)
            drive_deleted = True
    elif gdrive.is_connected and gdrive.root_folder_id:
        plat_fid = gdrive.get_or_create_folder(platform)
        if plat_fid:
            month_fid = gdrive.get_or_create_folder(month, plat_fid)
            if month_fid:
                drive_deleted = gdrive.empty_or_delete_folder(month_fid)

    return {
        'success': True,
        'platform': platform,
        'month': month,
        'deleted_count': local_deleted,
        'gdrive_deleted': drive_deleted
    }


def sync_single_tax_file(platform, month, filename, is_old=False):
    """
    Syncs a single file to Google Drive via Google Apps Script Web App.
    """
    platform = normalize_platform(platform)
    month = normalize_month(month)
    month_dir = os.path.join(TAX_STORAGE_DIR, platform, month)
    target_dir = os.path.join(month_dir, 'old') if is_old else month_dir
    fpath = os.path.join(target_dir, filename)

    if not os.path.exists(fpath):
        return {'success': False, 'error': f"File not found: {filename}"}

    cfg = load_tax_config()
    gas_url = (cfg.get('gas_url') or '').strip()
    root_id = (cfg.get('folder_id') or gdrive.root_folder_id or '').strip()

    if not gas_url:
        return {'success': False, 'error': 'Google Apps Script Web App URL is not configured yet. Paste URL in Drive Settings.'}

    manifest = load_sync_manifest()
    sync_key = get_file_sync_key(platform, month, filename, is_old=is_old)
    pcode = manifest.get(sync_key, {}).get('party_code') or extract_party_code(fpath, platform)

    res = upload_to_gas(gas_url, fpath, filename, platform, month, pcode, root_id)
    if res and res.get('success'):
        file_id = res.get('file_id', '')
        mark_file_synced(platform, month, filename, drive_file_id=file_id, is_old=is_old, party_code=pcode)
        return {
            'success': True,
            'filename': filename,
            'is_synced': True,
            'file_id': file_id,
            'file_url': res.get('file_url', '')
        }
    else:
        return {'success': False, 'error': res.get('error', 'Sync failed') if res else 'No response from GAS'}


def sync_all_local_to_drive(platform=None, month=None):
    """
    Syncs all locally stored files into Google Drive via Google Apps Script.
    """
    cfg = load_tax_config()
    gas_url = (cfg.get('gas_url') or '').strip()
    root_id = (cfg.get('folder_id') or gdrive.root_folder_id or '').strip()
    if not gas_url:
        return {'success': False, 'error': 'Google Apps Script Web App URL is not configured yet. Paste your Web App URL in Drive Settings.'}

    manifest = load_sync_manifest()
    synced_count = 0
    errors = []
    
    plats = [normalize_platform(platform)] if platform else VALID_PLATFORMS
    for p in plats:
        p_dir = os.path.join(TAX_STORAGE_DIR, p)
        if not os.path.exists(p_dir):
            continue
        m_list = [month.lower()] if month else [d for d in os.listdir(p_dir) if os.path.isdir(os.path.join(p_dir, d))]
        for m in m_list:
            m_path = os.path.join(p_dir, m)
            if not os.path.exists(m_path):
                continue
            for f in os.listdir(m_path):
                fpath = os.path.join(m_path, f)
                if os.path.isfile(fpath) and not f.startswith('.'):
                    sync_key = get_file_sync_key(p, m, f, is_old=False)
                    pcode = manifest.get(sync_key, {}).get('party_code') or extract_party_code(fpath, p)
                    res = upload_to_gas(gas_url, fpath, f, p, m, pcode, root_id)
                    if res and res.get('success'):
                        mark_file_synced(p, m, f, drive_file_id=res.get('file_id'), is_old=False, party_code=pcode)
                        synced_count += 1
                    else:
                        errors.append(f"{f}: {res.get('error', 'Failed')}")

    return {
        'success': True,
        'synced_count': synced_count,
        'errors': errors
    }


def export_month_as_zip(platform, month, output_zip_path):
    """
    Bundles all active files of a platform's month into a single downloadable .zip archive.
    If physical files are missing locally (e.g. on Render ephemeral disk), downloads them from Google Drive.
    """
    platform = normalize_platform(platform)
    month = normalize_month(month)
    month_dir = os.path.join(TAX_STORAGE_DIR, platform, month)

    manifest = load_sync_manifest()
    files_added = 0
    added_names = set()

    with zipfile.ZipFile(output_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        # 1. Add any local files
        if os.path.exists(month_dir):
            for fname in os.listdir(month_dir):
                fpath = os.path.join(month_dir, fname)
                if os.path.isfile(fpath) and not fname.startswith('.'):
                    zf.write(fpath, arcname=fname)
                    added_names.add(fname)
                    files_added += 1

        # 2. Add files recorded in manifest (Google Drive) that aren't on local disk
        for sync_key, s_info in manifest.items():
            parts = sync_key.split('/')
            if len(parts) == 3 and normalize_platform(parts[0]) == platform and normalize_month(parts[1]) == month:
                fname = parts[2]
                if fname not in added_names:
                    d_id = s_info.get('drive_file_id')
                    if d_id:
                        try:
                            d_url = f"https://drive.google.com/uc?export=download&id={d_id}"
                            r = requests.get(d_url, timeout=25)
                            if r.status_code == 200 and len(r.content) > 0:
                                zf.writestr(fname, r.content)
                                added_names.add(fname)
                                files_added += 1
                        except Exception as ex:
                            print(f"Error fetching file from Drive for zip ({fname}): {ex}")

    return files_added > 0


def sync_with_google_drive():
    """
    Queries Google Apps Script for the live structure in Google Drive.
    If folders or files were deleted in Drive, syncs local manifest and status.
    """
    cfg = load_tax_config()
    gas_url = (cfg.get('gas_url') or '').strip()
    root_id = (cfg.get('folder_id') or gdrive.root_folder_id or '').strip()
    if not gas_url:
        return {'success': False, 'error': 'Google Apps Script URL not configured'}

    try:
        payload = {
            'action': 'get_drive_structure',
            'root_folder_id': root_id
        }
        res = requests.post(gas_url, json=payload, timeout=25)
        data = res.json()
        if not data.get('success'):
            return {'success': False, 'error': data.get('error', 'Unknown response from GAS')}

        drive_platforms = data.get('platforms', {})
        manifest = load_sync_manifest()
        manifest_changed = False

        for sync_key, info in list(manifest.items()):
            if not info.get('synced'):
                continue
            parts = sync_key.split('/')
            if len(parts) < 3:
                continue
            p, m, fn = parts[0], parts[1], parts[2]
            drive_m = drive_platforms.get(p, {}).get('months', {}).get(m)
            if not drive_m:
                # The whole month folder was deleted in Drive!
                info['synced'] = False
                info['drive_file_id'] = ''
                manifest[sync_key] = info
                manifest_changed = True
            else:
                drive_files = [f['name'] for f in drive_m.get('files', [])]
                if fn not in drive_files:
                    # File was deleted in Drive!
                    info['synced'] = False
                    info['drive_file_id'] = ''
                    manifest[sync_key] = info
                    manifest_changed = True

        if manifest_changed:
            save_sync_manifest(manifest)

        return {'success': True, 'platforms': drive_platforms}
    except Exception as e:
        return {'success': False, 'error': str(e)}

