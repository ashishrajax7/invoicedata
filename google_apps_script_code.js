/**
 * ==============================================================================
 * GOOGLE APPS SCRIPT: Tax Report & Persistent ZIP Storage Automation Hub
 * ==============================================================================
 * Instructions to deploy or update:
 * 1. Open https://script.google.com/ and open your deployed project
 * 2. Select all code, replace with this entire file, and click Save (Floppy icon).
 * 3. Click "Deploy" (top-right blue button) -> "Manage deployments" -> Click Edit (pencil icon)
 *    -> Under Version, select "New version" -> Click "Deploy".
 *
 * SETTING UP 9-HOUR AUTO-EXPIRY TRIGGER (Runs 24/7 on Google Cloud):
 * 1. On left sidebar in script.google.com, click "Triggers" (Alarm clock icon ⏰).
 * 2. Click "+ Add Trigger" (bottom right).
 * 3. Configure:
 *    - Choose which function to run: cleanupExpiredZipFiles
 *    - Choose which deployment should run: Head
 *    - Select event source: Time-driven
 *    - Select type of time based trigger: Hour timer
 *    - Select hour interval: Every hour
 * 4. Click Save. Any files/parties older than 9 hours are auto-deleted.
 * ==============================================================================
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action || 'upload';
    var rootFolderId = data.root_folder_id || '1aFmrWvPx-0QHkIkhieB-a9F2r9Zi8OOu';

    var rootFolder = DriveApp.getFolderById(rootFolderId);

    if (action === 'ping') {
      return jsonResponse({
        success: true,
        message: 'Google Apps Script is connected & active!',
        user: Session.getActiveUser().getEmail()
      });
    }

    // ==========================================
    // 📊 TAX REPORT ACTIONS
    // ==========================================

    if (action === 'upload') {
      var platform = data.platform || 'MYNTRA';
      var month = (data.month || 'sep').toLowerCase();
      var filename = data.filename;
      var partyCode = data.party_code || '';
      var base64Content = data.content;

      var platFolder = getOrCreateFolder(rootFolder, capitalizePlatform(platform));
      var monthFolder = getOrCreateFolder(platFolder, month);

      if (partyCode) {
        var existingFiles = monthFolder.getFiles();
        var oldFolder = null;
        while (existingFiles.hasNext()) {
          var ef = existingFiles.next();
          var efName = ef.getName();
          if (efName.indexOf(partyCode) !== -1 && efName !== filename) {
            if (!oldFolder) oldFolder = getOrCreateFolder(monthFolder, 'old');
            ef.moveTo(oldFolder);
          }
        }
      }

      var sameNameFiles = monthFolder.getFilesByName(filename);
      while (sameNameFiles.hasNext()) {
        sameNameFiles.next().setTrashed(true);
      }

      var decoded = Utilities.base64Decode(base64Content);
      var blob = Utilities.newBlob(decoded, data.mimetype || 'application/octet-stream', filename);
      var newFile = monthFolder.createFile(blob);

      return jsonResponse({
        success: true,
        file_id: newFile.getId(),
        file_url: newFile.getUrl(),
        filename: filename
      });
    }

    if (action === 'rename') {
      var platform = data.platform || 'MYNTRA';
      var month = (data.month || 'sep').toLowerCase();
      var oldName = data.old_filename;
      var newName = data.new_filename;

      var platFolder = getOrCreateFolder(rootFolder, capitalizePlatform(platform));
      var monthFolder = getOrCreateFolder(platFolder, month);

      var files = monthFolder.getFilesByName(oldName);
      var count = 0;
      while (files.hasNext()) {
        var f = files.next();
        f.setName(newName);
        count++;
      }
      return jsonResponse({ success: true, renamed: count });
    }

    if (action === 'delete') {
      var platform = data.platform || 'MYNTRA';
      var month = (data.month || 'sep').toLowerCase();
      var filename = data.filename;
      var isOld = data.is_old || false;

      var platFolder = getOrCreateFolder(rootFolder, capitalizePlatform(platform));
      var targetFolder = getOrCreateFolder(platFolder, month);
      if (isOld) targetFolder = getOrCreateFolder(targetFolder, 'old');

      var files = targetFolder.getFilesByName(filename);
      while (files.hasNext()) {
        files.next().setTrashed(true);
      }
      return jsonResponse({ success: true });
    }

    if (action === 'delete_all') {
      var platform = data.platform || 'MYNTRA';
      var month = (data.month || 'sep').toLowerCase();
      var includeOld = data.include_old !== false;

      var platFolder = getOrCreateFolder(rootFolder, capitalizePlatform(platform));
      var targetFolder = getOrCreateFolder(platFolder, month);

      var count = 0;
      var files = targetFolder.getFiles();
      while (files.hasNext()) {
        files.next().setTrashed(true);
        count++;
      }

      if (includeOld) {
        var oldFolders = targetFolder.getFoldersByName('old');
        while (oldFolders.hasNext()) {
          var of = oldFolders.next();
          var oldFiles = of.getFiles();
          while (oldFiles.hasNext()) {
            oldFiles.next().setTrashed(true);
            count++;
          }
        }
      }

      try {
        targetFolder.setTrashed(true);
      } catch (fErr) {}

      return jsonResponse({ success: true, deleted_count: count });
    }

    if (action === 'get_drive_structure') {
      var platforms = ['AJIO', 'MYNTRA', 'FLIPKART'];
      var result = {};

      for (var i = 0; i < platforms.length; i++) {
        var plat = platforms[i];
        result[plat] = { months: {} };
        var platFolderIter = rootFolder.getFoldersByName(capitalizePlatform(plat));
        if (platFolderIter.hasNext()) {
          var pf = platFolderIter.next();
          var monthFolders = pf.getFolders();
          while (monthFolders.hasNext()) {
            var mf = monthFolders.next();
            if (!mf.isTrashed()) {
              var mName = mf.getName().toLowerCase();
              var filesList = [];
              var mFiles = mf.getFiles();
              while (mFiles.hasNext()) {
                var file = mFiles.next();
                if (!file.isTrashed()) {
                  filesList.push({
                    id: file.getId(),
                    name: file.getName(),
                    size: file.getSize()
                  });
                }
              }
              if (filesList.length > 0) {
                result[plat].months[mName] = {
                  month: mName,
                  files_count: filesList.length,
                  files: filesList
                };
              }
            }
          }
        }
      }

      return jsonResponse({ success: true, platforms: result });
    }

    // ==========================================
    // 📦 PERSISTENT ZIP STORAGE ACTIONS
    // ==========================================

    if (action === 'zip_upload_file') {
      var platform = data.platform || 'AJIO';
      var partyCode = String(data.party_code || 'UNKNOWN').trim();
      var category = data.category || 'od'; // 'od', 'details', 'summary', 'two_more_invoice'
      var filename = data.filename;
      var base64Content = data.content;

      // 1. Get or merge ZIP_STORAGE (Guarantees NO duplicate folders)
      var zipStorageFolder = getOrCreateZipStorageFolder(rootFolder);
      var platFolder = getOrCreateFolder(zipStorageFolder, capitalizePlatform(platform));
      var partyFolder = getOrCreateFolder(platFolder, partyCode);

      // 2. ALWAYS create all 4 standard folders for every party:
      getOrCreateFolder(partyFolder, 'od');
      getOrCreateFolder(partyFolder, 'details');
      getOrCreateFolder(partyFolder, 'summary');
      getOrCreateFolder(partyFolder, 'two_more_invoice');

      var catFolder = getOrCreateFolder(partyFolder, category);

      // Overwrite file if same name already exists in category folder
      var sameNameFiles = catFolder.getFilesByName(filename);
      while (sameNameFiles.hasNext()) {
        sameNameFiles.next().setTrashed(true);
      }

      var decoded = Utilities.base64Decode(base64Content);
      var blob = Utilities.newBlob(decoded, data.mimetype || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename);
      var newFile = catFolder.createFile(blob);

      return jsonResponse({
        success: true,
        file_id: newFile.getId(),
        file_url: newFile.getUrl(),
        filename: filename,
        party_code: partyCode,
        platform: platform,
        category: category
      });
    }

    if (action === 'zip_save_registry') {
      var zipStorageFolder = getOrCreateZipStorageFolder(rootFolder);
      var regContent = typeof data.registry === 'string' ? data.registry : JSON.stringify(data.registry, null, 2);

      var existingReg = zipStorageFolder.getFilesByName('registry.json');
      while (existingReg.hasNext()) {
        existingReg.next().setTrashed(true);
      }

      var regFile = zipStorageFolder.createFile('registry.json', regContent, 'application/json');
      return jsonResponse({ success: true, file_id: regFile.getId() });
    }

    if (action === 'zip_get_registry') {
      var zipStorageFolder = getOrCreateZipStorageFolder(rootFolder);
      var regFiles = zipStorageFolder.getFilesByName('registry.json');
      if (!regFiles.hasNext()) {
        return jsonResponse({ success: true, registry: null, message: 'registry.json not found' });
      }
      var regFile = regFiles.next();
      var content = regFile.getBlob().getDataAsString();
      var parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch (pe) {
        parsed = null;
      }
      return jsonResponse({ success: true, registry: parsed });
    }

    if (action === 'zip_download_file') {
      var fileId = data.file_id;
      var file = null;
      if (fileId) {
        try {
          file = DriveApp.getFileById(fileId);
        } catch (fe) {}
      }
      if (!file) {
        var platform = data.platform || 'AJIO';
        var partyCode = String(data.party_code || '').trim();
        var category = data.category || 'od';
        var filename = data.filename;

        var zipStorageFolder = getOrCreateZipStorageFolder(rootFolder);
        var platFolder = getOrCreateFolder(zipStorageFolder, capitalizePlatform(platform));
        var partyFolder = getOrCreateFolder(platFolder, partyCode);
        var catFolder = getOrCreateFolder(partyFolder, category);
        var fIter = catFolder.getFilesByName(filename);
        if (fIter.hasNext()) {
          file = fIter.next();
        }
      }

      if (!file || file.isTrashed()) {
        return jsonResponse({ success: false, error: 'File not found on Drive or expired' });
      }

      var b64 = Utilities.base64Encode(file.getBlob().getBytes());
      return jsonResponse({
        success: true,
        filename: file.getName(),
        content: b64,
        size: file.getSize(),
        mimetype: file.getMimeType()
      });
    }

    if (action === 'zip_clear_storage') {
      var platform = (data.platform || 'ALL').toString().trim().toUpperCase();

      // If ALL: Find and trash ALL ZIP_STORAGE folders directly in rootFolder (deletes duplicates too!)
      if (!platform || platform === 'ALL') {
        var allZipFolders = rootFolder.getFoldersByName('ZIP_STORAGE');
        var trashedCount = 0;
        while (allZipFolders.hasNext()) {
          try {
            allZipFolders.next().setTrashed(true);
            trashedCount++;
          } catch(e) {}
        }
        return jsonResponse({
          success: true,
          message: 'ZIP_STORAGE (' + trashedCount + ' folders) deleted from Google Drive'
        });
      }

      // If specific platform (e.g. 'AJIO', 'MYNTRA', 'FLIPKART'):
      var zipStorageFolder = getOrCreateZipStorageFolder(rootFolder);

      // Trash any platform folder matching case-insensitively (e.g. 'Myntra', 'MYNTRA', 'myntra')
      var subFolders = zipStorageFolder.getFolders();
      var trashedSub = 0;
      while (subFolders.hasNext()) {
        var sf = subFolders.next();
        if (sf.getName().toUpperCase() === platform) {
          try {
            sf.setTrashed(true);
            trashedSub++;
          } catch(e) {}
        }
      }

      // Also clean platform entry in registry.json on Drive
      var regFiles = zipStorageFolder.getFilesByName('registry.json');
      if (regFiles.hasNext()) {
        var rf = regFiles.next();
        try {
          var reg = JSON.parse(rf.getBlob().getDataAsString());
          if (reg && reg.platforms && reg.platforms[platform]) {
            reg.platforms[platform] = { parties: {}, stats: { order_zips: 0, details_zips: 0, summary_zips: 0 } };
            rf.setContent(JSON.stringify(reg, null, 2));
          }
        } catch(e) {}
      }

      return jsonResponse({
        success: true,
        message: 'Platform ' + platform + ' deleted from Google Drive ZIP storage'
      });
    }

    if (action === 'zip_delete_party') {
      var platform = (data.platform || 'AJIO').toString().trim().toUpperCase();
      var partyCode = String(data.party_code || '').trim();
      var zipStorageFolder = getOrCreateZipStorageFolder(rootFolder);
      var pFolders = zipStorageFolder.getFolders();
      var deleted = false;
      while (pFolders.hasNext()) {
        var pf = pFolders.next();
        if (pf.getName().toUpperCase() === platform) {
          var partyIter = pf.getFoldersByName(partyCode);
          while (partyIter.hasNext()) {
            try {
              partyIter.next().setTrashed(true);
              deleted = true;
            } catch(e) {}
          }
        }
      }
      var regFiles = zipStorageFolder.getFilesByName('registry.json');
      if (regFiles.hasNext()) {
        var rf = regFiles.next();
        try {
          var reg = JSON.parse(rf.getBlob().getDataAsString());
          if (reg && reg.platforms && reg.platforms[platform] && reg.platforms[platform].parties) {
            delete reg.platforms[platform].parties[partyCode];
            rf.setContent(JSON.stringify(reg, null, 2));
          }
        } catch(e) {}
      }
      return jsonResponse({
        success: true,
        deleted: deleted,
        party_code: partyCode,
        message: 'Party ' + partyCode + ' deleted from Google Drive'
      });
    }

    if (action === 'cleanup_expired_zip' || action === 'force_cleanup') {
      var cleanedCount = cleanupExpiredZipFiles();
      return jsonResponse({ success: true, message: 'Expired zip cleanup completed', deleted_count: cleanedCount });
    }

    return jsonResponse({ success: false, error: 'Unknown action: ' + action });

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

function doGet(e) {
  return jsonResponse({
    success: true,
    message: 'Tax Report & ZIP Persistent Storage GAS Web App is running smoothly!',
    time: new Date().toISOString()
  });
}

/**
 * Ensures single unique folder under parent (auto-ignores and trashes duplicates)
 */
function getOrCreateFolder(parent, name) {
  var folders = parent.getFoldersByName(name);
  var chosen = null;
  while (folders.hasNext()) {
    var f = folders.next();
    if (!f.isTrashed()) {
      if (!chosen) {
        chosen = f;
      } else {
        // Trash redundant duplicate folder if empty or merge
        try {
          var files = f.getFiles();
          while (files.hasNext()) files.next().moveTo(chosen);
          var subs = f.getFolders();
          while (subs.hasNext()) subs.next().moveTo(chosen);
          f.setTrashed(true);
        } catch(e) {}
      }
    }
  }
  if (chosen) return chosen;
  return parent.createFolder(name);
}

/**
 * Handles ZIP_STORAGE specifically:
 * Prevents multiple ZIP_STORAGE folders from being created by race conditions.
 * If duplicate ZIP_STORAGE folders exist, merges all contents into primary and trashes duplicates!
 */
function getOrCreateZipStorageFolder(rootFolder) {
  var folders = rootFolder.getFoldersByName('ZIP_STORAGE');
  var primary = null;
  var duplicates = [];
  while (folders.hasNext()) {
    var f = folders.next();
    if (!f.isTrashed()) {
      if (!primary) {
        primary = f;
      } else {
        duplicates.push(f);
      }
    }
  }

  if (!primary) {
    return rootFolder.createFolder('ZIP_STORAGE');
  }

  // Merge any duplicate ZIP_STORAGE folders
  for (var i = 0; i < duplicates.length; i++) {
    var dup = duplicates[i];
    try {
      var subFolders = dup.getFolders();
      while (subFolders.hasNext()) {
        var sub = subFolders.next();
        if (!sub.isTrashed()) {
          var targetPlat = getOrCreateFolder(primary, sub.getName());
          var parties = sub.getFolders();
          while (parties.hasNext()) {
            var party = parties.next();
            if (!party.isTrashed()) {
              var targetParty = getOrCreateFolder(targetPlat, party.getName());
              var cats = party.getFolders();
              while (cats.hasNext()) {
                var cat = cats.next();
                if (!cat.isTrashed()) {
                  var targetCat = getOrCreateFolder(targetParty, cat.getName());
                  var files = cat.getFiles();
                  while (files.hasNext()) {
                    var file = files.next();
                    if (!file.isTrashed()) {
                      file.moveTo(targetCat);
                    }
                  }
                }
              }
            }
          }
        }
      }

      var looseFiles = dup.getFiles();
      while (looseFiles.hasNext()) {
        var lf = looseFiles.next();
        if (!lf.isTrashed()) {
          lf.moveTo(primary);
        }
      }
      dup.setTrashed(true);
    } catch (mergeErr) {
      Logger.log('Note on duplicate folder cleanup: ' + mergeErr);
    }
  }

  return primary;
}

function capitalizePlatform(p) {
  var up = (p || '').toUpperCase();
  if (up === 'AJIO') return 'Ajio';
  if (up === 'MYNTRA') return 'Myntra';
  if (up === 'FLIPKART') return 'Flipkart';
  return p;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * ==============================================================================
 * TIME-DRIVEN TRIGGER: 9-HOUR AUTO-EXPIRY FOR ZIP FILES (RUNS ON GOOGLE CLOUD)
 * ==============================================================================
 * Ultra-fast execution (< 5 seconds):
 * Checks all party folders against registry.json or 9-hour age.
 * Trashes expired party folders in 1 instant operation per party (no deep nested timeouts!).
 */
function cleanupExpiredZipFiles() {
  var rootFolderId = '1aFmrWvPx-0QHkIkhieB-a9F2r9Zi8OOu';
  var rootFolder = DriveApp.getFolderById(rootFolderId);
  var zipStorageFolder = getOrCreateZipStorageFolder(rootFolder);

  var now = new Date().getTime();
  var NINE_HOURS_MS = 9 * 60 * 60 * 1000; // 9 hours
  var deletedCount = 0;

  // 1. Read registry.json on Drive for exact expiry timestamps
  var regData = null;
  var regFile = null;
  var regFiles = zipStorageFolder.getFilesByName('registry.json');
  if (regFiles.hasNext()) {
    regFile = regFiles.next();
    try {
      regData = JSON.parse(regFile.getBlob().getDataAsString());
    } catch (e) {}
  }

  // 2. Scan all platform folders
  var platformFolders = zipStorageFolder.getFolders();
  while (platformFolders.hasNext()) {
    var pf = platformFolders.next();
    if (pf.isTrashed()) continue;
    var pName = pf.getName().toUpperCase();
    var partyFolders = pf.getFolders();

    while (partyFolders.hasNext()) {
      var partyFolder = partyFolders.next();
      if (partyFolder.isTrashed()) continue;
      var pCode = partyFolder.getName();
      var isExpired = false;

      // Priority 1: Check registry.json expires_at
      if (regData && regData.platforms && regData.platforms[pName] && regData.platforms[pName].parties) {
        var pEntry = regData.platforms[pName].parties[pCode];
        if (pEntry) {
          var expStr = pEntry.expires_at || pEntry.updated_at || pEntry.uploaded_at;
          if (expStr) {
            try {
              var expTime = new Date(expStr).getTime();
              if (pEntry.expires_at) {
                if (now >= expTime) isExpired = true;
              } else {
                if ((now - expTime) >= NINE_HOURS_MS) isExpired = true;
              }
            } catch (dtErr) {}
          }
        }
      }

      // Priority 2: Fallback check folder created/updated dates
      if (!isExpired) {
        try {
          var created = partyFolder.getDateCreated().getTime();
          var updated = partyFolder.getLastUpdated().getTime();
          if ((now - created) >= NINE_HOURS_MS || (now - updated) >= NINE_HOURS_MS) {
            isExpired = true;
          }
        } catch (fErr) {}
      }

      // Fast 1-operation deletion of the entire expired party folder
      if (isExpired) {
        try {
          Logger.log('Deleting expired party folder: ' + partyFolder.getName() + ' (' + pName + ')');
          partyFolder.setTrashed(true);
          deletedCount++;
          if (regData && regData.platforms && regData.platforms[pName] && regData.platforms[pName].parties) {
            delete regData.platforms[pName].parties[pCode];
          }
        } catch (delErr) {
          Logger.log('Error trashing party folder ' + pCode + ': ' + delErr);
        }
      }
    }
  }

  // 3. Save cleaned registry.json
  if (deletedCount > 0 && regFile && regData) {
    try {
      regFile.setContent(JSON.stringify(regData, null, 2));
    } catch (saveErr) {}
  }

  Logger.log('cleanupExpiredZipFiles completed. Deleted ' + deletedCount + ' party folders.');
  return deletedCount;
}
