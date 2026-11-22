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
 * 4. Click Save. That's it! Any files older than 9 hours will be auto-deleted.
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

      // 1. Get or create platform folder (e.g. Myntra)
      var platFolder = getOrCreateFolder(rootFolder, capitalizePlatform(platform));

      // 2. Get or create month folder (e.g. sep)
      var monthFolder = getOrCreateFolder(platFolder, month);

      // 3. Move existing file for same party into old/ subfolder
      if (partyCode) {
        var existingFiles = monthFolder.getFiles();
        var oldFolder = null;
        while (existingFiles.hasNext()) {
          var ef = existingFiles.next();
          var efName = ef.getName();
          // Check if party code matches and it's not the exact same filename
          if (efName.indexOf(partyCode) !== -1 && efName !== filename) {
            if (!oldFolder) oldFolder = getOrCreateFolder(monthFolder, 'old');
            ef.moveTo(oldFolder);
          }
        }
      }

      // 4. Overwrite same named file if it already exists in month folder
      var sameNameFiles = monthFolder.getFilesByName(filename);
      while (sameNameFiles.hasNext()) {
        sameNameFiles.next().setTrashed(true);
      }

      // 5. Create new file from base64 content
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

      // Also trash the month folder itself so Drive doesn't keep an empty month folder
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

      var zipStorageFolder = getOrCreateFolder(rootFolder, 'ZIP_STORAGE');
      var platFolder = getOrCreateFolder(zipStorageFolder, capitalizePlatform(platform));
      var partyFolder = getOrCreateFolder(platFolder, partyCode);
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
      var zipStorageFolder = getOrCreateFolder(rootFolder, 'ZIP_STORAGE');
      var regContent = typeof data.registry === 'string' ? data.registry : JSON.stringify(data.registry, null, 2);

      var existingReg = zipStorageFolder.getFilesByName('registry.json');
      while (existingReg.hasNext()) {
        existingReg.next().setTrashed(true);
      }

      var regFile = zipStorageFolder.createFile('registry.json', regContent, 'application/json');
      return jsonResponse({ success: true, file_id: regFile.getId() });
    }

    if (action === 'zip_get_registry') {
      var zipFolders = rootFolder.getFoldersByName('ZIP_STORAGE');
      if (!zipFolders.hasNext()) {
        return jsonResponse({ success: true, registry: null, message: 'ZIP_STORAGE folder not created yet' });
      }
      var zipFolder = zipFolders.next();
      var regFiles = zipFolder.getFilesByName('registry.json');
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

        var zipStorageFolder = getOrCreateFolder(rootFolder, 'ZIP_STORAGE');
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
      var platform = data.platform;
      var zipFolders = rootFolder.getFoldersByName('ZIP_STORAGE');
      if (zipFolders.hasNext()) {
        var zipFolder = zipFolders.next();
        if (platform && platform.toUpperCase() !== 'ALL') {
          var pFolders = zipFolder.getFoldersByName(capitalizePlatform(platform));
          while (pFolders.hasNext()) {
            pFolders.next().setTrashed(true);
          }
        } else {
          var allP = zipFolder.getFolders();
          while (allP.hasNext()) {
            allP.next().setTrashed(true);
          }
          var allF = zipFolder.getFiles();
          while (allF.hasNext()) {
            allF.next().setTrashed(true);
          }
        }
      }
      return jsonResponse({ success: true, message: 'ZIP storage cleared on Google Drive' });
    }

    if (action === 'cleanup_expired_zip') {
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

function getOrCreateFolder(parent, name) {
  var folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
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
 * Automatically checks ZIP_STORAGE folder and trashes any party folders or files
 * created more than 9 hours ago.
 * Set trigger in script.google.com -> Triggers -> Add Trigger -> Every Hour.
 */
function cleanupExpiredZipFiles() {
  var rootFolderId = '1aFmrWvPx-0QHkIkhieB-a9F2r9Zi8OOu';
  var rootFolder = DriveApp.getFolderById(rootFolderId);
  var zipFolders = rootFolder.getFoldersByName('ZIP_STORAGE');
  if (!zipFolders.hasNext()) return 0;
  var zipFolder = zipFolders.next();

  var now = new Date().getTime();
  var NINE_HOURS_MS = 9 * 60 * 60 * 1000; // 9 hours (32,400,000 milliseconds)
  var deletedCount = 0;

  var platformFolders = zipFolder.getFolders();
  while (platformFolders.hasNext()) {
    var pf = platformFolders.next();
    var partyFolders = pf.getFolders();
    while (partyFolders.hasNext()) {
      var partyFolder = partyFolders.next();
      var folderCreated = partyFolder.getDateCreated().getTime();

      // If the party folder was created more than 9 hours ago
      if ((now - folderCreated) >= NINE_HOURS_MS) {
        Logger.log('Deleting expired party folder: ' + partyFolder.getName() + ' (' + pf.getName() + ')');
        partyFolder.setTrashed(true);
        deletedCount++;
      } else {
        // Inspect individual category subfolders & files
        var catFolders = partyFolder.getFolders();
        while (catFolders.hasNext()) {
          var catF = catFolders.next();
          var files = catF.getFiles();
          while (files.hasNext()) {
            var f = files.next();
            if ((now - f.getDateCreated().getTime()) >= NINE_HOURS_MS) {
              Logger.log('Deleting expired file: ' + f.getName());
              f.setTrashed(true);
              deletedCount++;
            }
          }
        }
      }
    }
  }
  Logger.log('cleanupExpiredZipFiles finished. Total deleted items: ' + deletedCount);
  return deletedCount;
}
