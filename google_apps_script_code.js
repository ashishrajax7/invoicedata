/**
 * ==============================================================================
 * GOOGLE APPS SCRIPT: Tax Report & Drive Automation Hub
 * ==============================================================================
 * Instructions to deploy:
 * 1. Open https://script.google.com/ and click "New project"
 * 2. Delete existing code, paste all contents of this file, and click Save (Floppy icon).
 * 3. Click "Deploy" (top-right blue button) -> "New deployment"
 * 4. In "Select type", click gear icon -> choose "Web app"
 * 5. Configuration:
 *    - Description: Tax Report Drive Sync
 *    - Execute as: Me (<your-email>@gmail.com)  <-- IMPORTANT!
 *    - Who has access: Anyone                   <-- IMPORTANT!
 * 6. Click "Deploy", click "Authorize access", choose your Google Account,
 *    click "Advanced" -> "Go to (unsafe)", and click "Allow".
 * 7. Copy the "Web app URL" (starts with https://script.google.com/macros/s/.../exec)
 * 8. Paste it in your Dashboard -> "Drive Settings" -> "Google Apps Script Web App URL".
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
              // Only register month if it has files
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

    return jsonResponse({ success: false, error: 'Unknown action: ' + action });

  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

function doGet(e) {
  return jsonResponse({
    success: true,
    message: 'Tax Report Google Apps Script Web App is running smoothly!',
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

