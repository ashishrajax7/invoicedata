/**
 * High-Speed Instant-Load Multi-Sheet Frontend
 * Marketplace Tabs: AJIO (Short List), Myntra (Party Details), Flipkart (Summary)
 * Custom Modal Confirmation (No browser default popups)
 * Instant Local Cache + Sub-Millisecond Backend + Color Export + Complete Clear All
 */

let appData = {
    filename: 'Combined (All 3 Files)',
    is_combined: true,
    available_files: [],
    active_file: '__all__',
    detailed_rows: [],
    block_sheets: {
        'Short List': [],
        'Party Details': [],
        'Summary': []
    },
    stats: {}
};

let activeTab = 'zipbundles';
let activeSummarySubTab = 'shortlist';
let sheetFilters = {
    'Short List': 'all',
    'Party Details': 'all',
    'Summary': 'all'
};
let searchQuery = '';
let hasUnsavedChanges = false;

const tabSheetMap = {
    'shortlist': 'Short List',
    'partydetails': 'Party Details',
    'summary': 'Summary'
};

/**
 * Custom Animated Confirmation Modal (Replaces browser default alert/confirm)
 */
function showCustomConfirm({
    title = 'Are you sure?',
    message = 'This action cannot be undone.',
    icon = 'fa-triangle-exclamation',
    iconColor = 'text-rose-600',
    iconBg = 'bg-rose-100',
    confirmText = 'Confirm',
    confirmBtnClass = 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/30'
}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('customConfirmModal');
        const titleEl = document.getElementById('customConfirmTitle');
        const msgEl = document.getElementById('customConfirmMessage');
        const iconEl = document.getElementById('customConfirmIcon');
        const iconContainer = document.getElementById('customConfirmIconContainer');
        const cancelBtn = document.getElementById('customConfirmCancelBtn');
        const actionBtn = document.getElementById('customConfirmActionBtn');

        if (!modal) {
            resolve(window.confirm(message));
            return;
        }

        titleEl.textContent = title;
        msgEl.textContent = message;
        
        iconEl.className = `fa-solid ${icon}`;
        iconContainer.className = `w-14 h-14 mx-auto mb-4 rounded-full flex items-center justify-center ${iconBg} ${iconColor} text-2xl shadow-inner`;

        actionBtn.textContent = confirmText;
        actionBtn.className = `w-1/2 py-2.5 px-4 text-xs font-bold text-white ${confirmBtnClass} active:scale-95 rounded-xl shadow-md transition`;

        modal.classList.remove('hidden');

        function cleanup(result) {
            modal.classList.add('hidden');
            cancelBtn.onclick = null;
            actionBtn.onclick = null;
            document.removeEventListener('keydown', handleKey);
            resolve(result);
        }

        function handleKey(e) {
            if (e.key === 'Escape') cleanup(false);
            if (e.key === 'Enter') cleanup(true);
        }

        cancelBtn.onclick = () => cleanup(false);
        actionBtn.onclick = () => cleanup(true);
        document.addEventListener('keydown', handleKey);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // 1. Instant Paint from LocalStorage if exists
    try {
        const cached = localStorage.getItem('invoice_app_cache_data');
        if (cached) {
            const parsedCache = JSON.parse(cached);
            if (parsedCache && parsedCache.block_sheets) {
                appData = parsedCache;
                renderFileSelector();
                renderLoadedFilesList();
                renderAllSheets();
                renderKPIs();
            }
        }
    } catch (e) {}

    // 2. Setup 3-Platform Excel Drag & Drop Zones
    setupExcelDropzones();
    setupTaxDropzones();

    // 3. Initialize default month for tax reports
    const curTaxMonth = getCurrentMonthCode();
    const tSelFiles = document.getElementById('taxUploadMonthSelectFiles');
    if (tSelFiles) tSelFiles.value = curTaxMonth;
    taxActiveMonth = curTaxMonth;

    const taxRenameFormEl = document.getElementById('taxRenameForm');
    if (taxRenameFormEl) {
        taxRenameFormEl.addEventListener('submit', handleTaxRenameSubmit);
    }

    // 4. Fast background sync with server
    switchTab('zipbundles');
    switchZipPlatform('AJIO');
    switchSummarySubTab('shortlist');
    switchUploadSubTab('zip');
    loadData(appData.active_file || '__all__', false);
    loadZipStatus(false);

    window.addEventListener('beforeunload', (e) => {
        if (hasUnsavedChanges) {
            e.preventDefault();
            e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        }
    });
});

/**
 * Fetch all sheets & data from backend with instant caching
 */
async function loadData(filename = '__all__', showToastMsg = true) {
    if (showToastMsg) showToast('Refreshing...', 'info');
    try {
        let url = `/api/data?filename=${encodeURIComponent(filename)}`;
        const res = await fetch(url);
        const result = await res.json();
        
        if (!result.success) {
            if (showToastMsg) showToast(result.error || 'Failed to load data', 'error');
            return;
        }

        appData = result.data;
        if (!appData.block_sheets) appData.block_sheets = {};
        if (!appData.block_sheets['Short List']) appData.block_sheets['Short List'] = [];
        if (!appData.block_sheets['Party Details']) appData.block_sheets['Party Details'] = [];
        if (!appData.block_sheets['Summary']) appData.block_sheets['Summary'] = [];
        
        try {
            localStorage.setItem('invoice_app_cache_data', JSON.stringify(appData));
        } catch (e) {}

        renderFileSelector();
        renderLoadedFilesList();
        renderAllSheets();
        renderKPIs();
        loadBackupsList();
        
        setUnsavedState(false);
        if (showToastMsg) {
            const modeLabel = appData.active_file === '__all__' ? 'Combined 3-in-1 Mode' : appData.active_file;
            showToast(`Ready: ${modeLabel}`, 'success');
        }
    } catch (err) {
        console.error(err);
        if (showToastMsg) showToast('Error connecting to server', 'error');
    }
}

/**
 * Render File Selector Dropdown with visible text and marketplace tags
 */
function renderFileSelector() {
    const sel = document.getElementById('fileSelector');
    if (!sel) return;
    sel.innerHTML = '';

    const optAll = document.createElement('option');
    optAll.value = '__all__';
    optAll.textContent = '🌐 [ALL 3 FILES] Combined View';
    optAll.style.color = '#0f172a';
    optAll.style.backgroundColor = '#ffffff';
    optAll.selected = (appData.active_file === '__all__');
    sel.appendChild(optAll);

    (appData.available_files || []).forEach(f => {
        let tag = 'File';
        if (f.toUpperCase().includes('REPORT')) tag = 'AJIO';
        else if (f.toUpperCase().includes('SUMMARY') && !f.toUpperCase().includes('FK')) tag = 'Myntra';
        else if (f.toUpperCase().includes('FK')) tag = 'Flipkart';

        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = `📄 [${tag}] ${f}`;
        opt.style.color = '#0f172a';
        opt.style.backgroundColor = '#ffffff';
        opt.selected = (f === appData.active_file);
        sel.appendChild(opt);
    });
}

async function switchExcelFile(filename) {
    if (hasUnsavedChanges) {
        const confirmed = await showCustomConfirm({
            title: 'Discard Unsaved Changes?',
            message: 'You have unsaved changes. Switching file view will discard them.',
            icon: 'fa-triangle-exclamation',
            iconColor: 'text-amber-600',
            iconBg: 'bg-amber-100',
            confirmText: 'Discard & Switch',
            confirmBtnClass: 'bg-amber-600 hover:bg-amber-500 shadow-amber-600/30'
        });
        if (!confirmed) {
            renderFileSelector();
            return;
        }
    }
    loadData(filename, true);
}

function setUnsavedState(dirty = true) {
    hasUnsavedChanges = dirty;
    const badge = document.getElementById('unsavedBadge');
    const saveBtn = document.getElementById('saveBtn');
    if (badge) {
        badge.classList.toggle('hidden', !dirty);
        badge.classList.toggle('flex', dirty);
    }
    if (saveBtn) {
        if (dirty) {
            saveBtn.classList.remove('bg-emerald-600', 'hover:bg-emerald-500');
            saveBtn.classList.add('bg-amber-600', 'hover:bg-amber-500', 'animate-pulse');
            saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i><span>Save Changes *</span>`;
        } else {
            saveBtn.classList.remove('bg-amber-600', 'hover:bg-amber-500', 'animate-pulse');
            saveBtn.classList.add('bg-emerald-600', 'hover:bg-emerald-500');
            saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i><span>Save All to Excel</span>`;
        }
    }
}

function switchTab(tabId) {
    // If old platform tab id passed, redirect into unified invoice summary tab with that subtab
    if (['shortlist', 'partydetails', 'summary'].includes(tabId)) {
        switchTab('invoicesummary');
        switchSummarySubTab(tabId);
        return;
    }

    activeTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active', 'text-indigo-700', 'bg-indigo-50', 'border-indigo-200', 'text-emerald-700', 'bg-emerald-50', 'border-emerald-200', 'text-amber-700', 'bg-amber-50', 'border-amber-200', 'text-slate-900', 'bg-slate-100');
        btn.classList.add('text-slate-600');
    });

    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));

    const activeBtn = document.getElementById(`tab-${tabId}`);
    if (activeBtn) {
        activeBtn.classList.remove('text-slate-600');
        if (tabId === 'zipbundles') {
            activeBtn.classList.add('active', 'text-indigo-700', 'bg-indigo-50', 'border-indigo-200');
        } else if (tabId === 'invoicesummary') {
            activeBtn.classList.add('active', 'text-emerald-700', 'bg-emerald-50', 'border-emerald-200');
        } else if (tabId === 'files') {
            activeBtn.classList.add('active', 'text-slate-900', 'bg-slate-100');
        } else if (tabId === 'taxreport') {
            activeBtn.classList.add('active', 'text-amber-700', 'bg-amber-50', 'border-amber-200');
        } else {
            activeBtn.classList.add('active', 'text-slate-900', 'bg-slate-100');
        }
    }

    const panelEl = document.getElementById(`panel-${tabId}`);
    if (panelEl) panelEl.classList.remove('hidden');

    if (tabId === 'zipbundles') {
        loadZipStatus(false);
    } else if (tabId === 'taxreport') {
        loadTaxReports(false);
    }

    updateAddBtnLabel();
}

function switchSummarySubTab(subTabId) {
    activeSummarySubTab = subTabId;

    const brandColors = {
        shortlist: 'text-purple-600',
        partydetails: 'text-blue-600',
        summary: 'text-amber-600',
        uploadbox: 'text-emerald-600'
    };

    ['shortlist', 'partydetails', 'summary', 'uploadbox'].forEach(st => {
        const btn = document.getElementById(`subtab-${st}`);
        const panel = document.getElementById(`subpanel-${st}`);
        if (btn) {
            btn.classList.remove('active', 'bg-purple-600', 'bg-blue-600', 'bg-amber-600', 'bg-emerald-600', 'text-white', 'shadow-xs', 'bg-white', 'border-purple-200', 'text-purple-700');
            btn.classList.add('text-slate-600');
            const icon = btn.querySelector('i');
            if (icon) {
                icon.className = icon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' ' + (brandColors[st] || 'text-slate-500');
            }
        }
        if (panel) panel.classList.add('hidden');
    });

    const activeBtn = document.getElementById(`subtab-${subTabId}`);
    const activeSubpanel = document.getElementById(`subpanel-${subTabId}`);

    if (activeBtn) {
        activeBtn.classList.remove('text-slate-600');
        activeBtn.classList.add('active', 'text-white', 'shadow-xs');
        if (subTabId === 'shortlist') activeBtn.classList.add('bg-purple-600');
        else if (subTabId === 'partydetails') activeBtn.classList.add('bg-blue-600');
        else if (subTabId === 'summary') activeBtn.classList.add('bg-amber-600');
        else if (subTabId === 'uploadbox') activeBtn.classList.add('bg-emerald-600');

        const activeIcon = activeBtn.querySelector('i');
        if (activeIcon) {
            activeIcon.className = activeIcon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' text-white';
        }
    }

    if (activeSubpanel) {
        activeSubpanel.classList.remove('hidden');
    }

    updateAddBtnLabel();
}

let activeUploadSubTab = 'zip';

function switchUploadSubTab(subTabId) {
    activeUploadSubTab = subTabId || 'zip';
    const subTabs = ['zip', 'summary', 'tax'];

    subTabs.forEach(st => {
        const panel = document.getElementById(`uploadSubPanel-${st}`);
        const btn = document.getElementById(`uploadSubTabBtn-${st}`);
        const isActive = (st === activeUploadSubTab);

        if (panel) {
            if (isActive) panel.classList.remove('hidden');
            else panel.classList.add('hidden');
        }

        if (btn) {
            const icon = btn.querySelector('i');
            if (isActive) {
                const bgClass = st === 'zip' ? 'bg-indigo-600' : (st === 'summary' ? 'bg-emerald-600' : 'bg-amber-600');
                btn.className = `upload-subtab-btn px-4 py-2 rounded-lg text-xs font-bold transition flex items-center gap-2 shadow-2xs text-white ${bgClass}`;
                if (icon) {
                    icon.className = icon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' text-white';
                }
            } else {
                btn.className = 'upload-subtab-btn px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition flex items-center gap-2';
                if (icon) {
                    const iconColor = st === 'zip' ? 'text-indigo-600' : (st === 'summary' ? 'text-emerald-600' : 'text-amber-600');
                    icon.className = icon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' ' + iconColor;
                }
            }
        }
    });
}
window.switchUploadSubTab = switchUploadSubTab;

function updateAddBtnLabel() {
    const addBtnLabel = document.getElementById('addBtnLabel');
    if (!addBtnLabel) return;
    if (activeTab === 'invoicesummary') {
        if (activeSummarySubTab === 'shortlist') addBtnLabel.textContent = 'Add to AJIO';
        else if (activeSummarySubTab === 'partydetails') addBtnLabel.textContent = 'Add to Myntra';
        else if (activeSummarySubTab === 'summary') addBtnLabel.textContent = 'Add to Flipkart';
        else addBtnLabel.textContent = 'Add Party';
    } else if (activeTab === 'shortlist') {
        addBtnLabel.textContent = 'Add to AJIO';
    } else if (activeTab === 'partydetails') {
        addBtnLabel.textContent = 'Add to Myntra';
    } else if (activeTab === 'summary') {
        addBtnLabel.textContent = 'Add to Flipkart';
    } else {
        addBtnLabel.textContent = 'Add Party';
    }
}

function openAddModalForActiveTab() {
    if (activeTab === 'invoicesummary') {
        if (activeSummarySubTab === 'shortlist') openAddBlockItemModal('Short List');
        else if (activeSummarySubTab === 'partydetails') openAddBlockItemModal('Party Details');
        else if (activeSummarySubTab === 'summary') openAddBlockItemModal('Summary');
        else openAddBlockItemModal('Short List');
    } else if (['shortlist', 'partydetails', 'summary'].includes(activeTab)) {
        const sheetName = tabSheetMap[activeTab];
        openAddBlockItemModal(sheetName);
    } else {
        openAddBlockItemModal('Short List');
    }
}

function renderTopOverviewZipCounts() {
    const platforms = (zipStatusData && zipStatusData.platforms) ? zipStatusData.platforms : {};

    // 1. AJIO
    const ajio = platforms['AJIO'] || { parties: [] };
    const ajioOd = ajio.od_count !== undefined ? ajio.od_count : (ajio.parties || []).filter(p => p.has_od || p.has_order_file).length;
    const ajioTwoMore = ajio.two_more_count !== undefined ? ajio.two_more_count : (ajio.parties || []).filter(p => p.has_two_more_invoice).length;
    const ajioDetails = ajio.details_count !== undefined ? ajio.details_count : (ajio.parties || []).filter(p => p.has_details).length;
    const ajioSummary = ajio.summary_count !== undefined ? ajio.summary_count : (ajio.parties || []).filter(p => p.has_summary).length;

    const elAjioOd = document.getElementById('ajioZipOdCount');
    if (elAjioOd) elAjioOd.textContent = ajioOd;
    const elAjio2M = document.getElementById('ajioZipTwoMoreCount');
    if (elAjio2M) elAjio2M.textContent = ajioTwoMore;
    const elAjioDet = document.getElementById('ajioZipDetailsCount');
    if (elAjioDet) elAjioDet.textContent = ajioDetails;
    const elAjioSum = document.getElementById('ajioZipSummaryCount');
    if (elAjioSum) elAjioSum.textContent = ajioSummary;

    // 2. MYNTRA
    const myntra = platforms['MYNTRA'] || { parties: [] };
    const myntraOd = myntra.od_count !== undefined ? myntra.od_count : (myntra.order_count !== undefined ? myntra.order_count : (myntra.parties || []).filter(p => p.has_od || p.has_order_file || p.has_pr).length);
    const myntraTwoMore = myntra.two_more_count !== undefined ? myntra.two_more_count : (myntra.parties || []).filter(p => p.has_two_more_invoice).length;
    const myntraDetails = myntra.details_count !== undefined ? myntra.details_count : (myntra.parties || []).filter(p => p.has_details).length;
    const myntraSummary = myntra.summary_count !== undefined ? myntra.summary_count : (myntra.parties || []).filter(p => p.has_summary).length;

    const elMynOd = document.getElementById('myntraZipOdCount');
    if (elMynOd) elMynOd.textContent = myntraOd;
    const elMynPr = document.getElementById('myntraZipPrCount');
    if (elMynPr) elMynPr.textContent = myntraOd;
    const elMyn2M = document.getElementById('myntraZipTwoMoreCount');
    if (elMyn2M) elMyn2M.textContent = myntraTwoMore;
    const elMynDet = document.getElementById('myntraZipDetailsCount');
    if (elMynDet) elMynDet.textContent = myntraDetails;
    const elMynSum = document.getElementById('myntraZipSummaryCount');
    if (elMynSum) elMynSum.textContent = myntraSummary;

    // 3. FLIPKART
    const fk = platforms['FLIPKART'] || { parties: [] };
    const fkOd = fk.od_count !== undefined ? fk.od_count : (fk.order_count !== undefined ? fk.order_count : (fk.parties || []).filter(p => p.has_od || p.has_order_file || p.has_pr).length);
    const fkTwoMore = fk.two_more_count !== undefined ? fk.two_more_count : (fk.parties || []).filter(p => p.has_two_more_invoice).length;
    const fkDetails = fk.details_count !== undefined ? fk.details_count : (fk.parties || []).filter(p => p.has_details).length;
    const fkSummary = fk.summary_count !== undefined ? fk.summary_count : (fk.parties || []).filter(p => p.has_summary).length;

    const elFkOd = document.getElementById('flipkartZipOdCount');
    if (elFkOd) elFkOd.textContent = fkOd;
    const elFkPr = document.getElementById('flipkartZipPrCount');
    if (elFkPr) elFkPr.textContent = fkOd;
    const elFk2M = document.getElementById('flipkartZipTwoMoreCount');
    if (elFk2M) elFk2M.textContent = fkTwoMore;
    const elFkDet = document.getElementById('flipkartZipDetailsCount');
    if (elFkDet) elFkDet.textContent = fkDetails;
    const elFkSum = document.getElementById('flipkartZipSummaryCount');
    if (elFkSum) elFkSum.textContent = fkSummary;
}

function renderKPIs() {
    const slItems = (appData.block_sheets && appData.block_sheets['Short List']) || [];
    const slDone = slItems.filter(s => (s.status || '').toUpperCase() === 'DONE').length;
    const elSlCount = document.getElementById('kpiShortlistCount');
    if (elSlCount) elSlCount.textContent = slItems.length;
    const elSlDone = document.getElementById('kpiShortlistDone');
    if (elSlDone) elSlDone.textContent = `${slDone} Done`;
    const elSlPending = document.getElementById('kpiShortlistPending');
    if (elSlPending) elSlPending.textContent = `${slItems.length - slDone} Pending`;

    const subCountSl = document.getElementById('subtabCountShortlist');
    if (subCountSl) subCountSl.textContent = `${slDone}/${slItems.length}`;

    const pdItems = (appData.block_sheets && appData.block_sheets['Party Details']) || [];
    const pdDone = pdItems.filter(s => (s.status || '').toUpperCase() === 'DONE').length;
    const pdNot = pdItems.filter(s => (s.status || '').toUpperCase() === 'NOT').length;
    const elPdCount = document.getElementById('kpiPartyDetailsCount');
    if (elPdCount) elPdCount.textContent = pdItems.length;
    const elPdDone = document.getElementById('kpiPartyDetailsDone');
    if (elPdDone) elPdDone.textContent = `${pdDone} Done`;
    const elPdNot = document.getElementById('kpiPartyDetailsNot');
    if (elPdNot) elPdNot.textContent = `${pdNot} Not`;

    const subCountPd = document.getElementById('subtabCountPartyDetails');
    if (subCountPd) subCountPd.textContent = `${pdDone}/${pdItems.length}`;

    const smItems = (appData.block_sheets && appData.block_sheets['Summary']) || [];
    const smDone = smItems.filter(s => (s.status || '').toUpperCase() === 'DONE').length;
    const elSmCount = document.getElementById('kpiSummaryCount');
    if (elSmCount) elSmCount.textContent = smItems.length;
    const elSmDone = document.getElementById('kpiSummaryDone');
    if (elSmDone) elSmDone.textContent = `${smDone} Done`;
    const elSmPending = document.getElementById('kpiSummaryPending');
    if (elSmPending) elSmPending.textContent = `${smItems.length - smDone} Pending`;

    const subCountSm = document.getElementById('subtabCountSummary');
    if (subCountSm) subCountSm.textContent = `${smDone}/${smItems.length}`;

    const totalSummaryCount = slItems.length + pdItems.length + smItems.length;
    const elTabSummaryCount = document.getElementById('tabCountInvoiceSummary');
    if (elTabSummaryCount) elTabSummaryCount.textContent = `${totalSummaryCount}`;

    renderTopOverviewZipCounts();
}

function renderAllSheets() {
    renderBlockSheet('Short List', 'container-ShortList');
    renderBlockSheet('Party Details', 'container-PartyDetails');
    renderBlockSheet('Summary', 'container-Summary');
}

function setBlockFilter(sheetName, filterType) {
    sheetFilters[sheetName] = filterType;
    const prefix = sheetName.replace(/\s+/g, '');
    ['all', 'done', 'not', 'pending'].forEach(f => {
        const btn = document.getElementById(`filter-${prefix}-${f}`);
        if (btn) {
            if (f === filterType) {
                btn.className = 'px-2.5 py-1 rounded-md font-medium bg-slate-900 text-white transition shadow-2xs';
            } else {
                btn.className = 'px-2.5 py-1 rounded-md font-normal text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition';
            }
        }
    });
    const containerId = `container-${prefix}`;
    renderBlockSheet(sheetName, containerId);
}

/**
 * Render Marketplace Block Sheet (No Strikethrough on DONE - Pure bold clean text)
 */
function renderBlockSheet(sheetName, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    let items = appData.block_sheets[sheetName] || [];
    const filter = sheetFilters[sheetName] || 'all';

    if (filter === 'done') {
        items = items.filter(s => (s.status || '').toUpperCase() === 'DONE');
    } else if (filter === 'not') {
        items = items.filter(s => (s.status || '').toUpperCase() === 'NOT');
    } else if (filter === 'pending') {
        items = items.filter(s => !s.status || (s.status.toUpperCase() !== 'DONE' && s.status.toUpperCase() !== 'NOT'));
    }

    if (searchQuery) {
        items = items.filter(s => 
            (s.party_name || '').toLowerCase().includes(searchQuery) ||
            (s.invoice_range || '').toLowerCase().includes(searchQuery) ||
            (s.source_file || '').toLowerCase().includes(searchQuery)
        );
    }

    const platformLabel = sheetName === 'Short List' ? 'AJIO' : sheetName === 'Party Details' ? 'Myntra' : 'Flipkart';

    if (items.length === 0) {
        container.innerHTML = `
            <div class="col-span-full py-12 text-center text-slate-400 bg-white rounded-xl border border-slate-200">
                <i class="fa-solid fa-folder-open text-4xl mb-2 text-slate-300"></i>
                <p>No parties in <strong>${platformLabel}</strong>. Ready for new Excel upload!</p>
            </div>
        `;
        return;
    }

    const fragment = document.createDocumentFragment();

    items.forEach(item => {
        const statusUpper = (item.status || '').toUpperCase();
        const isDone = statusUpper === 'DONE';
        const isNot = statusUpper === 'NOT';
        const isPending = !isDone && !isNot;
        const isRangeNotFound = (item.invoice_range || '').toLowerCase().includes('notfound') || (item.invoice_range || '').toUpperCase() === 'N/A';

        const card = document.createElement('div');
           let cardTheme = 'bg-white border-slate-200/90 hover:border-slate-300 shadow-2xs';
        let statusBadgeHtml = `
            <button onclick="cycleBlockItemStatus('${sheetName}', ${item.id})" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-slate-100/80 text-slate-600 border border-slate-200/80 hover:bg-slate-200/60 transition active:scale-95 cursor-pointer" title="Click to change status">
                <i class="fa-regular fa-circle text-[9px] text-slate-400"></i>
                <span>PENDING</span>
            </button>
        `;

        if (isDone) {
            cardTheme = 'bg-white border-emerald-300 ring-1 ring-emerald-400/20 shadow-2xs';
            statusBadgeHtml = `
                <button onclick="cycleBlockItemStatus('${sheetName}', ${item.id})" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-2xs hover:bg-emerald-100 transition active:scale-95 cursor-pointer" title="Click to change status">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    <i class="fa-solid fa-check text-[10px] text-emerald-600"></i>
                    <span>DONE</span>
                </button>
            `;
        } else if (isNot) {
            cardTheme = 'bg-white border-rose-300 ring-1 ring-rose-400/20 shadow-2xs';
            statusBadgeHtml = `
                <button onclick="cycleBlockItemStatus('${sheetName}', ${item.id})" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200 shadow-2xs hover:bg-rose-100 transition active:scale-95 cursor-pointer" title="Click to change status">
                    <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                    <i class="fa-solid fa-xmark text-[10px] text-rose-600"></i>
                    <span>NOT</span>
                </button>
            `;
        }

        // Check if ZIP files exist for this party
        const partyCodeMatch = (item.party_name || '').match(/^(\d+|[A-Za-z0-9]+)/);
        const pCode = partyCodeMatch ? partyCodeMatch[1] : '';
        const pPlatform = sheetName === 'Short List' ? 'AJIO' : sheetName === 'Party Details' ? 'MYNTRA' : 'FLIPKART';
        const zipParty = ((zipStatusData.platforms && zipStatusData.platforms[pPlatform]) ? zipStatusData.platforms[pPlatform].parties || [] : []).find(p => p.party_code === pCode);

        let zipPillsHtml = '';
        if (zipParty) {
            let pills = [];
            const hasOrd = zipParty.has_order_file || zipParty.has_od || zipParty.has_pr;
            const ordLabel = 'OD';
            if (hasOrd) pills.push(`<span class="text-[9px] bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.5 rounded border border-emerald-300" title="${ordLabel} File Attached">${ordLabel}</span>`);
            if (zipParty.has_two_more_invoice) pills.push('<span class="text-[9px] bg-amber-100 text-amber-800 font-bold px-1.5 py-0.5 rounded border border-amber-300" title="2 More Invoice Attached">2M</span>');
            if (zipParty.has_details) pills.push('<span class="text-[9px] bg-blue-100 text-blue-800 font-bold px-1.5 py-0.5 rounded border border-blue-300" title="Details Sheet Attached">DT</span>');
            if (zipParty.has_summary) pills.push('<span class="text-[9px] bg-purple-100 text-purple-800 font-bold px-1.5 py-0.5 rounded border border-purple-300" title="Summary Sheet Attached">SM</span>');
            if (pills.length > 0) {
                zipPillsHtml = `
                    <div class="mt-1.5 flex items-center justify-between text-[10px] bg-indigo-50/50 px-2 py-1 rounded-md border border-indigo-100/70">
                        <span class="text-indigo-700 font-semibold flex items-center gap-1"><i class="fa-solid fa-file-zipper text-indigo-600"></i> ZIP:</span>
                        <div class="flex items-center gap-1">${pills.join('')}</div>
                    </div>
                `;
            }
        }

        let nameColor = 'text-slate-900';
        if (sheetName === 'Short List') nameColor = 'text-purple-950 hover:text-purple-700';
        else if (sheetName === 'Party Details') nameColor = 'text-blue-950 hover:text-blue-700';
        else if (sheetName === 'Summary') nameColor = 'text-amber-950 hover:text-amber-700';
        if (isDone) nameColor = 'text-emerald-950';
        else if (isNot) nameColor = 'text-rose-950';

        card.className = `party-card group relative p-3.5 rounded-xl border transition-all duration-200 select-none flex flex-col justify-between min-h-[130px] ${cardTheme}`;

        card.innerHTML = `
            <div>
                <!-- Top Row: Party Name & Status Badge -->
                <div class="flex items-start justify-between gap-2">
                    <div class="flex-1 min-w-0">
                        <div class="font-bold text-sm tracking-tight leading-snug ${nameColor} dark-crisp editable-cell px-1.5 py-0.5 transition"
                             contenteditable="true"
                             onblur="handleBlockItemEdit('${sheetName}', ${item.id}, 'party_name', this.innerText)"
                             onkeydown="handleCellKeydown(event, this)">
                            ${escapeHtml(item.party_name)}
                        </div>
                    </div>
                    <div class="shrink-0">
                        ${statusBadgeHtml}
                    </div>
                </div>

                <!-- Middle Row: Invoice Range Monospace Container -->
                <div class="mt-2 flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-indigo-50/60 border border-indigo-100 text-xs font-mono">
                    <div class="flex items-center gap-1.5 min-w-0 flex-1">
                        <i class="fa-solid fa-barcode text-xs ${isDone ? 'text-emerald-600' : isNot ? 'text-rose-600' : 'text-indigo-500'}"></i>
                        <span class="${isRangeNotFound ? 'text-rose-600 font-bold italic' : 'text-indigo-950 font-bold'} truncate editable-cell px-1 py-0.5"
                              contenteditable="true"
                              onblur="handleBlockItemEdit('${sheetName}', ${item.id}, 'invoice_range', this.innerText)"
                              onkeydown="handleCellKeydown(event, this)">
                            ${escapeHtml(item.invoice_range || 'N/A')}
                        </span>
                    </div>
                    <span class="text-[10px] font-sans font-semibold text-indigo-400 shrink-0 ml-1">#${item.id}</span>
                </div>

                ${zipPillsHtml}
            </div>

            <!-- Bottom Row: Quick Status Triggers & Actions -->
            <div class="flex items-center justify-between pt-2 mt-2 border-t border-slate-100 text-xs">
                <!-- Status Toggle Buttons -->
                <div class="flex items-center gap-1">
                    <button onclick="cycleBlockItemStatus('${sheetName}', ${item.id}, 'DONE')" 
                            class="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition active:scale-95 ${isDone ? 'bg-emerald-600 text-white shadow-2xs' : 'text-emerald-700 hover:bg-emerald-100/80 bg-emerald-50/60 border border-emerald-200/60'}" 
                            title="Mark as Done">
                        <i class="fa-solid fa-check text-[10px]"></i>
                        <span>Done</span>
                    </button>
                    
                    <button onclick="cycleBlockItemStatus('${sheetName}', ${item.id}, 'NOT')" 
                            class="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition active:scale-95 ${isNot ? 'bg-rose-600 text-white shadow-2xs' : 'text-rose-700 hover:bg-rose-100/80 bg-rose-50/60 border border-rose-200/60'}" 
                            title="Mark as Not">
                        <i class="fa-solid fa-xmark text-[10px]"></i>
                        <span>Not</span>
                    </button>

                    <button onclick="cycleBlockItemStatus('${sheetName}', ${item.id}, '')" 
                            class="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-normal text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition active:scale-95" 
                            title="Clear Status">
                        <i class="fa-regular fa-circle text-[9px]"></i>
                        <span>Reset</span>
                    </button>
                </div>

                <!-- Card Action Icons -->
                <div class="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition">
                    <button onclick="openEditBlockModal('${sheetName}', ${item.id})" class="p-1 text-slate-400 hover:text-indigo-600 transition" title="Edit">
                        <i class="fa-regular fa-pen-to-square text-xs"></i>
                    </button>
                    <button onclick="deleteBlockItem('${sheetName}', ${item.id})" class="p-1 text-slate-400 hover:text-rose-600 transition" title="Delete">
                        <i class="fa-regular fa-trash-can text-xs"></i>
                    </button>
                </div>
            </div>
        `;
        fragment.appendChild(card);
    });

    container.appendChild(fragment);
}

function handleCellKeydown(e, el) {
    if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
    }
}

function handleBlockItemEdit(sheetName, itemId, field, newVal) {
    const items = appData.block_sheets[sheetName] || [];
    const item = items.find(s => s.id === itemId);
    if (!item) return;

    const cleanVal = newVal.trim();
    if (item[field] !== cleanVal) {
        item[field] = cleanVal;
        setUnsavedState(true);
        renderKPIs();
    }
}

function cycleBlockItemStatus(sheetName, itemId, explicitStatus = null) {
    const items = appData.block_sheets[sheetName] || [];
    const item = items.find(s => s.id === itemId);
    if (!item) return;

    if (explicitStatus !== null) {
        item.status = explicitStatus;
    } else {
        const cur = (item.status || '').toUpperCase();
        if (cur === '') item.status = 'DONE';
        else if (cur === 'DONE') item.status = 'NOT';
        else item.status = '';
    }

    setUnsavedState(true);
    const prefix = sheetName.replace(/\s+/g, '');
    renderBlockSheet(sheetName, `container-${prefix}`);
    renderKPIs();
}

function markAllBlockSheet(sheetName, targetStatus = 'DONE') {
    const items = appData.block_sheets[sheetName] || [];
    items.forEach(s => {
        s.status = targetStatus;
    });
    setUnsavedState(true);
    const prefix = sheetName.replace(/\s+/g, '');
    renderBlockSheet(sheetName, `container-${prefix}`);
    renderKPIs();
    const label = sheetName === 'Short List' ? 'AJIO' : sheetName === 'Party Details' ? 'Myntra' : 'Flipkart';
    showToast(`${label}: Marked all as ${targetStatus || 'PENDING'}`, 'success');
}

/**
 * Reset all statuses across all sheets back to PENDING (using Custom Modal)
 */
async function resetAllStatuses() {
    const confirmed = await showCustomConfirm({
        title: 'Reset All Statuses?',
        message: 'This will reset all checked DONE and NOT status back to PENDING across AJIO, Myntra, and Flipkart.\n\nParty names and invoice ranges will remain safe.',
        icon: 'fa-rotate-left',
        iconColor: 'text-indigo-600',
        iconBg: 'bg-indigo-100',
        confirmText: 'Reset Statuses',
        confirmBtnClass: 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/30'
    });
    if (!confirmed) return;

    ['Short List', 'Party Details', 'Summary'].forEach(s => {
        (appData.block_sheets[s] || []).forEach(item => item.status = '');
    });
    setUnsavedState(true);
    renderAllSheets();
    renderKPIs();
    showToast('All statuses reset to PENDING', 'info');
}

/**
 * CLEAR ALL UPLOADED EXCEL DATA & FILES (using Custom Modal)
 */
async function clearAllUploadedData() {
    const confirmed = await showCustomConfirm({
        title: 'Clear All Uploaded Data & Files?',
        message: 'This will remove all uploaded parties and Excel files from the dashboard screen so you can upload a fresh batch.\n\n🛡️ All existing files are automatically preserved safely in the backups folder.',
        icon: 'fa-trash-can',
        iconColor: 'text-rose-600',
        iconBg: 'bg-rose-100',
        confirmText: 'Yes, Clear All',
        confirmBtnClass: 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/30'
    });
    if (!confirmed) return;

    showToast('Clearing all uploaded data...', 'info');

    try {
        const res = await fetch('/api/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clear_files: true })
        });
        const result = await res.json();

        // Clear client cache and memory
        localStorage.removeItem('invoice_app_cache_data');
        appData = {
            filename: 'Combined (All 3 Files)',
            is_combined: true,
            available_files: [],
            active_file: '__all__',
            detailed_rows: [],
            block_sheets: {
                'Short List': [],
                'Party Details': [],
                'Summary': []
            },
            stats: {}
        };

        setUnsavedState(false);
        renderFileSelector();
        renderLoadedFilesList();
        renderAllSheets();
        renderKPIs();
        loadBackupsList();

        showToast('All uploaded Excel data cleared! Ready for fresh upload.', 'success');
    } catch (e) {
        showToast('Error clearing data', 'error');
    }
}

/**
 * Clear data for a single sheet (using Custom Modal)
 */
async function clearSheetData(sheetName) {
    const label = sheetName === 'Short List' ? 'AJIO' : sheetName === 'Party Details' ? 'Myntra' : 'Flipkart';
    const confirmed = await showCustomConfirm({
        title: `Clear ${label}?`,
        message: `Are you sure you want to remove all parties from "${label}"?`,
        icon: 'fa-trash-can',
        iconColor: 'text-rose-600',
        iconBg: 'bg-rose-100',
        confirmText: `Clear ${label}`,
        confirmBtnClass: 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/30'
    });
    if (!confirmed) return;

    appData.block_sheets[sheetName] = [];
    const prefix = sheetName.replace(/\s+/g, '');
    renderBlockSheet(sheetName, `container-${prefix}`);
    setUnsavedState(true);
    renderKPIs();
    showToast(`Cleared all items from ${label}`, 'info');
}

function copyBlockSheetToClipboard(sheetName) {
    const items = appData.block_sheets[sheetName] || [];
    const label = sheetName === 'Short List' ? 'AJIO' : sheetName === 'Party Details' ? 'Myntra' : 'Flipkart';
    if (items.length === 0) {
        showToast(`${label} is empty`, 'warning');
        return;
    }

    let text = `📦 ${label.toUpperCase()} REPORT (${appData.filename})\n`;
    text += `Generated: ${new Date().toLocaleString()}\n`;
    text += `====================================\n\n`;

    items.forEach(item => {
        const st = (item.status || '').toUpperCase();
        const stLabel = st === 'DONE' ? '✅ DONE' : st === 'NOT' ? '❌ NOT' : '⏳ PENDING';
        text += `• ${item.party_name} [${stLabel}]\n`;
        text += `  Range: ${item.invoice_range || 'N/A'}\n\n`;
    });

    navigator.clipboard.writeText(text).then(() => {
        showToast(`Copied ${label} to clipboard!`, 'success');
    }).catch(() => {
        showToast('Failed to copy to clipboard', 'error');
    });
}

function openAddBlockItemModal(sheetName) {
    const label = sheetName === 'Short List' ? 'AJIO' : sheetName === 'Party Details' ? 'Myntra' : 'Flipkart';
    document.getElementById('blockModalTitle').textContent = `Add Party to ${label}`;
    document.getElementById('formBlockSheetName').value = sheetName;
    document.getElementById('formBlockItemId').value = '';
    document.getElementById('blockItemForm').reset();
    document.getElementById('blockItemModal').classList.remove('hidden');
}

function openEditBlockItemModal(sheetName, itemId) {
    const items = appData.block_sheets[sheetName] || [];
    const item = items.find(s => s.id === itemId);
    if (!item) return;

    const label = sheetName === 'Short List' ? 'AJIO' : sheetName === 'Party Details' ? 'Myntra' : 'Flipkart';
    document.getElementById('blockModalTitle').textContent = `Edit Party in ${label}`;
    document.getElementById('formBlockSheetName').value = sheetName;
    document.getElementById('formBlockItemId').value = item.id;
    document.getElementById('formBlockPartyName').value = item.party_name || '';
    document.getElementById('formBlockInvoiceRange').value = item.invoice_range || '';
    document.getElementById('formBlockStatus').value = item.status || '';
    document.getElementById('blockItemModal').classList.remove('hidden');
}

function closeBlockItemModal() {
    document.getElementById('blockItemModal').classList.add('hidden');
}

function handleBlockItemFormSubmit(e) {
    e.preventDefault();
    const sheetName = document.getElementById('formBlockSheetName').value;
    const itemId = document.getElementById('formBlockItemId').value;
    const partyName = document.getElementById('formBlockPartyName').value.trim();
    const invRange = document.getElementById('formBlockInvoiceRange').value.trim() || 'N/A';
    const status = document.getElementById('formBlockStatus').value;

    if (!appData.block_sheets[sheetName]) appData.block_sheets[sheetName] = [];
    const items = appData.block_sheets[sheetName];
    const label = sheetName === 'Short List' ? 'AJIO' : sheetName === 'Party Details' ? 'Myntra' : 'Flipkart';

    if (itemId) {
        const target = items.find(s => s.id === parseInt(itemId));
        if (target) {
            target.party_name = partyName;
            target.invoice_range = invRange;
            target.status = status;
            showToast(`Updated ${partyName}`, 'success');
        }
    } else {
        const newId = (Math.max(0, ...items.map(s => s.id || 0)) || 0) + 1;
        items.push({
            id: newId,
            party_name: partyName,
            invoice_range: invRange,
            status: status,
            sheet_name: sheetName
        });
        showToast(`Added ${partyName} to ${label}`, 'success');
    }

    setUnsavedState(true);
    closeBlockItemModal();
    const prefix = sheetName.replace(/\s+/g, '');
    renderBlockSheet(sheetName, `container-${prefix}`);
    renderKPIs();
}

async function deleteBlockItem(sheetName, itemId) {
    const items = appData.block_sheets[sheetName] || [];
    const item = items.find(s => s.id === itemId);
    if (!item) return;

    const label = sheetName === 'Short List' ? 'AJIO' : sheetName === 'Party Details' ? 'Myntra' : 'Flipkart';
    const confirmed = await showCustomConfirm({
        title: 'Delete Party?',
        message: `Are you sure you want to delete "${item.party_name}" from ${label}?`,
        icon: 'fa-trash-can',
        iconColor: 'text-rose-600',
        iconBg: 'bg-rose-100',
        confirmText: 'Delete',
        confirmBtnClass: 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/30'
    });
    if (!confirmed) return;

    appData.block_sheets[sheetName] = items.filter(s => s.id !== itemId);
    setUnsavedState(true);
    const prefix = sheetName.replace(/\s+/g, '');
    renderBlockSheet(sheetName, `container-${prefix}`);
    renderKPIs();
    showToast(`Deleted "${item.party_name}"`, 'info');
}

async function saveAllChanges() {
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Saving...</span>`;
    }

    try {
        const res = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: appData.active_file || '__all__',
                detailed_rows: appData.detailed_rows || [],
                block_sheets: appData.block_sheets
            })
        });
        const result = await res.json();
        if (result.success) {
            setUnsavedState(false);
            try {
                localStorage.setItem('invoice_app_cache_data', JSON.stringify(appData));
            } catch (e) {}
            showToast(result.message || 'Saved successfully with colors!', 'success');
            loadBackupsList();
        } else {
            showToast(result.error || 'Failed to save to Excel', 'error');
        }
    } catch (e) {
        showToast('Network error while saving', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
        }
    }
}

function handleSearch(query) {
    searchQuery = (query || '').toLowerCase().trim();
    const clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !searchQuery);
    }
    renderAllSheets();
}

function clearSearch() {
    document.getElementById('globalSearchInput').value = '';
    handleSearch('');
}

async function uploadPlatformExcel(platform, files) {
    if (!files || files.length === 0) return;
    const file = files[0];
    const formData = new FormData();
    formData.append('file', file);
    formData.append('platform', platform);

    const statusEls = [
        document.getElementById(`excelUploadStatus-${platform}`),
        document.getElementById(`subpanel-excelUploadStatus-${platform}`)
    ];

    statusEls.forEach(el => {
        if (el) el.innerHTML = `<span class="text-indigo-600 font-semibold"><i class="fa-solid fa-spinner fa-spin"></i> Uploading ${escapeHtml(file.name)}...</span>`;
    });

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
            statusEls.forEach(el => {
                if (el) el.innerHTML = `<span class="text-emerald-600 font-semibold"><i class="fa-solid fa-check"></i> ${escapeHtml(data.saved_file || file.name)} uploaded!</span>`;
            });
            showToast(`${platform} Excel uploaded successfully!`, 'success');
            await loadData('__all__', true);
            updateLoadedExcelBadges();
        } else {
            statusEls.forEach(el => {
                if (el) el.innerHTML = `<span class="text-rose-600 font-semibold"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(data.error || 'Upload failed')}</span>`;
            });
            showToast(data.error || 'Upload failed', 'error');
        }
    } catch (e) {
        statusEls.forEach(el => {
            if (el) el.innerHTML = `<span class="text-rose-600 font-semibold"><i class="fa-solid fa-triangle-exclamation"></i> Network error during upload</span>`;
        });
        showToast('Network error during upload', 'error');
    } finally {
        ['excelFileInput-', 'subpanel-excelFileInput-'].forEach(prefix => {
            const input = document.getElementById(`${prefix}${platform}`);
            if (input) input.value = '';
        });
    }
}

async function uploadNewExcel(files) {
    if (!files || files.length === 0) return;
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
    }

    const statusEl = document.getElementById('uploadStatusMsg');
    if (statusEl) {
        statusEl.innerHTML = `<span class="text-indigo-600 font-semibold"><i class="fa-solid fa-spinner fa-spin"></i> Uploading ${files.length} file(s)...</span>`;
    }

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
            if (statusEl) {
                statusEl.innerHTML = `<span class="text-emerald-600 font-semibold">Uploaded ${data.saved_files ? data.saved_files.length : 1} file(s)! Reloading...</span>`;
            }
            loadData('__all__', true);
        } else {
            if (statusEl) {
                statusEl.innerHTML = `<span class="text-rose-600 font-semibold">${data.error || 'Upload failed'}</span>`;
            }
        }
    } catch (e) {
        if (statusEl) {
            statusEl.innerHTML = `<span class="text-rose-600 font-semibold">Network error during upload</span>`;
        }
    }
}

function updateLoadedExcelBadges() {
    const files = appData.available_files || [];
    const ajioFile = files.find(f => {
        const up = f.toUpperCase();
        return up.includes('AJIO') || up.includes('REPORT');
    });
    const myntraFile = files.find(f => {
        const up = f.toUpperCase();
        return up.includes('MYNTRA') || (up.includes('SUMMARY') && !up.includes('FK') && !up.includes('FLIPKART') && !up.includes('REPORT'));
    });
    const fkFile = files.find(f => {
        const up = f.toUpperCase();
        return up.includes('FK') || up.includes('FLIPKART');
    });

    const updateBadge = (plat, foundFile, colorBg, colorText) => {
        const badgeEls = [
            document.getElementById(`excelActiveBadge-${plat}`),
            document.getElementById(`subpanel-excelActiveBadge-${plat}`)
        ];
        badgeEls.forEach(el => {
            if (!el) return;
            if (foundFile) {
                el.innerHTML = `
                    <span class="inline-flex items-center gap-1 font-mono text-[11px] font-medium text-slate-700 truncate max-w-[190px]" title="${escapeHtml(foundFile)}">
                        <i class="fa-regular fa-file-excel ${colorText}"></i>
                        <span class="truncate">${escapeHtml(foundFile)}</span>
                    </span>
                    <span class="text-[10px] ${colorBg} ${colorText} px-2 py-0.5 rounded font-bold whitespace-nowrap">Active</span>
                `;
            } else {
                el.innerHTML = `<span class="text-slate-400 italic text-[11px]">No active file</span>`;
            }
        });
    };

    updateBadge('AJIO', ajioFile, 'bg-purple-100', 'text-purple-800');
    updateBadge('MYNTRA', myntraFile, 'bg-blue-100', 'text-blue-800');
    updateBadge('FLIPKART', fkFile, 'bg-amber-100', 'text-amber-800');
}

function setupExcelDropzones() {
    ['AJIO', 'MYNTRA', 'FLIPKART'].forEach(plat => {
        ['dropzone-excel-', 'subpanel-dropzone-excel-'].forEach(prefix => {
            const dropzone = document.getElementById(`${prefix}${plat}`);
            if (!dropzone) return;

            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.add('ring-2', 'ring-indigo-500', 'scale-[1.01]');
            });

            dropzone.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.remove('ring-2', 'ring-indigo-500', 'scale-[1.01]');
            });

            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.remove('ring-2', 'ring-indigo-500', 'scale-[1.01]');
                if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    uploadPlatformExcel(plat, e.dataTransfer.files);
                }
            });
        });
    });
}

function renderLoadedFilesList() {
    const container = document.getElementById('loadedFilesList');
    if (!container) return;
    container.innerHTML = '';

    updateLoadedExcelBadges();

    if (!appData.available_files || appData.available_files.length === 0) {
        container.innerHTML = `<div class="text-slate-400 italic py-2">No files currently active. Upload new files above.</div>`;
        return;
    }

    (appData.available_files || []).forEach(f => {
        let tag = 'General';
        let color = 'bg-slate-100 text-slate-700';
        const up = f.toUpperCase();
        if (up.includes('AJIO') || up.includes('REPORT')) {
            tag = 'AJIO';
            color = 'bg-purple-100 text-purple-800';
        } else if (up.includes('MYNTRA') || (up.includes('SUMMARY') && !up.includes('FK') && !up.includes('FLIPKART') && !up.includes('REPORT'))) {
            tag = 'Myntra';
            color = 'bg-blue-100 text-blue-800';
        } else if (up.includes('FK') || up.includes('FLIPKART')) {
            tag = 'Flipkart';
            color = 'bg-amber-100 text-amber-800';
        }

        const div = document.createElement('div');
        div.className = 'p-2 bg-white rounded-lg border border-slate-200 flex items-center justify-between';
        div.innerHTML = `
            <div class="flex items-center space-x-2 truncate">
                <i class="fa-regular fa-file-excel text-emerald-500"></i>
                <span class="font-mono font-medium text-slate-800 truncate">${escapeHtml(f)}</span>
            </div>
            <span class="text-[10px] px-2 py-0.5 rounded font-bold ${color}">${tag}</span>
        `;
        container.appendChild(div);
    });
}

async function loadBackupsList() {
    const container = document.getElementById('backupsList');
    if (!container) return;

    try {
        const res = await fetch('/api/files');
        const data = await res.json();
        if (data.success && data.backups) {
            container.innerHTML = '';
            if (data.backups.length === 0) {
                container.innerHTML = `<div class="text-slate-400 italic">No backups found yet. They are created automatically on each save/clear.</div>`;
                return;
            }
            data.backups.slice(0, 10).forEach(b => {
                const item = document.createElement('div');
                item.className = 'p-1.5 bg-white rounded border border-slate-200 flex items-center justify-between';
                item.innerHTML = `
                    <div class="truncate font-mono text-[10px] text-slate-700">
                        <i class="fa-regular fa-file-zipper text-amber-500 mr-1"></i>${escapeHtml(b)}
                    </div>
                    <span class="text-[9px] text-slate-400">Preserved</span>
                `;
                container.appendChild(item);
            });
        }
    } catch (e) {
        console.error(e);
    }
}

function exportExcelFile() {
    window.location.href = `/api/export?filename=${encodeURIComponent(appData.active_file || '__all__')}`;
}

function printSummaryReport() {
    const container = document.getElementById('printContainer');
    if (!container) return;

    let tableHtml = `
        <div style="padding: 20px; font-family: sans-serif;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 15px;">
                <div>
                    <h2 style="margin: 0; font-size: 20px;">INVOICE CHECKLIST REPORT</h2>
                    <p style="margin: 3px 0 0 0; font-size: 12px; color: #555;">AJIO • Myntra • Flipkart</p>
                </div>
                <div style="text-align: right; font-size: 12px;">
                    <div>Date: ${new Date().toLocaleDateString()}</div>
                </div>
            </div>
    `;

    ['Short List', 'Party Details', 'Summary'].forEach(s => {
        const items = appData.block_sheets[s] || [];
        const label = s === 'Short List' ? 'AJIO' : s === 'Party Details' ? 'MYNTRA' : 'FLIPKART';
        if (items.length > 0) {
            tableHtml += `
                <h3 style="margin-top: 15px; margin-bottom: 5px; color: #333;">${label} (${items.length} Parties)</h3>
                <table class="print-table" style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">
                    <thead>
                        <tr style="background: #f1f5f9;">
                            <th style="border: 1px solid #cbd5e1; padding: 6px; text-align: left;">Party Name</th>
                            <th style="border: 1px solid #cbd5e1; padding: 6px; text-align: left;">Invoice Range</th>
                            <th style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">Status</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            items.forEach(item => {
                tableHtml += `
                    <tr>
                        <td style="border: 1px solid #cbd5e1; padding: 6px;"><strong>${escapeHtml(item.party_name)}</strong></td>
                        <td style="border: 1px solid #cbd5e1; padding: 6px; font-family: monospace;">${escapeHtml(item.invoice_range || 'N/A')}</td>
                        <td style="border: 1px solid #cbd5e1; padding: 6px; text-align: center;">${escapeHtml(item.status || 'PENDING')}</td>
                    </tr>
                `;
            });
            tableHtml += `
                    </tbody>
                </table>
            `;
        }
    });

    tableHtml += `</div>`;
    container.innerHTML = tableHtml;
    window.print();
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    const bgColors = {
        success: 'bg-white text-emerald-900 border-emerald-200 shadow-lg',
        error: 'bg-white text-rose-900 border-rose-200 shadow-lg',
        warning: 'bg-white text-amber-900 border-amber-200 shadow-lg',
        info: 'bg-white text-slate-900 border-slate-200 shadow-lg'
    };

    const icons = {
        success: 'fa-circle-check text-emerald-600',
        error: 'fa-circle-xmark text-rose-600',
        warning: 'fa-triangle-exclamation text-amber-600',
        info: 'fa-circle-info text-indigo-600'
    };

    toast.className = `toast-enter pointer-events-auto px-3.5 py-2 rounded-lg shadow-lg border text-xs flex items-center space-x-2.5 max-w-sm ${bgColors[type] || bgColors.info}`;
    toast.innerHTML = `
        <i class="fa-solid ${icons[type] || icons.info} text-sm"></i>
        <span class="font-medium flex-1 text-slate-800">${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.remove('toast-enter');
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 250);
    }, 2500);
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ==========================================
// 📦 ZIP BUNDLE MANAGER STATE & FUNCTIONS
// ==========================================

let zipActivePlatform = 'AJIO';
let zipStatusData = {
    platforms: {
        'AJIO': { parties: [], stats: {} },
        'MYNTRA': { parties: [], stats: {} },
        'FLIPKART': { parties: [], stats: {} }
    },
    total_parties: 0,
    total_od_files: 0,
    total_two_more_invoices: 0,
    total_details_files: 0,
    total_summary_files: 0
};
let zipRegistrySearchQuery = '';
let currentPipelinePartyCode = '';

function switchZipPlatform(platform) {
    zipActivePlatform = (platform || 'AJIO').toUpperCase();
    const orderTypeLabel = 'OD';
    
    // Update platform button styles
    ['AJIO', 'MYNTRA', 'FLIPKART'].forEach(p => {
        const btn = document.getElementById(`zipPlatformBtn-${p}`);
        if (btn) {
            const icon = btn.querySelector('i');
            if (p === zipActivePlatform) {
                if (p === 'AJIO') {
                    btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-purple-600 text-white shadow-sm';
                } else if (p === 'MYNTRA') {
                    btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-blue-600 text-white shadow-sm';
                } else {
                    btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-amber-600 text-white shadow-sm';
                }
                if (icon) {
                    icon.className = icon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' text-white';
                }
            } else {
                btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition flex items-center gap-1.5';
                if (icon) {
                    const iconColor = p === 'AJIO' ? 'text-purple-600' : (p === 'MYNTRA' ? 'text-blue-600' : 'text-amber-600');
                    icon.className = icon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' ' + iconColor;
                }
            }
        }
    });

    const badge = document.getElementById('zipPlatformBadge');
    if (badge) {
        badge.textContent = zipActivePlatform;
        if (zipActivePlatform === 'AJIO') {
            badge.className = 'text-xs bg-purple-100 text-purple-800 border border-purple-200 px-2.5 py-0.5 rounded-md font-bold';
        } else if (zipActivePlatform === 'MYNTRA') {
            badge.className = 'text-xs bg-blue-100 text-blue-800 border border-blue-200 px-2.5 py-0.5 rounded-md font-bold';
        } else {
            badge.className = 'text-xs bg-amber-100 text-amber-800 border border-amber-200 px-2.5 py-0.5 rounded-md font-bold';
        }
    }

    // Dynamic Slot 1 Labels (OD + 2 More for ALL platforms)
    document.querySelectorAll('.zipSlot1Title, #zipSlot1Title').forEach(el => {
        el.textContent = 'Order ZIP (OD + 2 More)';
    });

    document.querySelectorAll('.zipSlot1Desc, #zipSlot1Desc').forEach(el => {
        const exampleZip = zipActivePlatform === 'AJIO' ? '101-157_processed.zip' : (zipActivePlatform === 'MYNTRA' ? '139-157 process.zip' : '101-157 order.zip');
        el.innerHTML = `Upload order zip (e.g. <code class="bg-slate-100 px-1 py-0.5 rounded text-slate-700">${exampleZip}</code>). Auto-saves OD and 2 More Invoice (optional).`;
    });

    document.querySelectorAll('.zipSlot1DropText, #zipSlot1DropText').forEach(el => {
        el.textContent = 'Select or Drop Order .zip (OD file)';
    });

    // Update secondary platform switcher buttons
    ['AJIO', 'MYNTRA', 'FLIPKART'].forEach(p => {
        const btn = document.getElementById(`filesZipBtn-${p}`);
        if (btn) {
            const icon = btn.querySelector('i');
            if (p === zipActivePlatform) {
                if (p === 'AJIO') btn.className = 'filesZipPlatBtn px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-purple-600 text-white shadow-xs';
                else if (p === 'MYNTRA') btn.className = 'filesZipPlatBtn px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-blue-600 text-white shadow-xs';
                else btn.className = 'filesZipPlatBtn px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-amber-600 text-white shadow-xs';
                if (icon) {
                    icon.className = icon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' text-white';
                }
            } else {
                btn.className = 'filesZipPlatBtn px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition flex items-center gap-1.5';
                if (icon) {
                    const iconColor = p === 'AJIO' ? 'text-purple-600' : (p === 'MYNTRA' ? 'text-blue-600' : 'text-amber-600');
                    icon.className = icon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' ' + iconColor;
                }
            }
        }
    });

    const filesBadge = document.getElementById('filesZipPlatformBadge');
    if (filesBadge) {
        filesBadge.textContent = zipActivePlatform;
        if (zipActivePlatform === 'AJIO') {
            filesBadge.className = 'text-xs bg-purple-100 text-purple-700 px-2.5 py-0.5 rounded-full font-bold';
        } else if (zipActivePlatform === 'MYNTRA') {
            filesBadge.className = 'text-xs bg-blue-100 text-blue-700 px-2.5 py-0.5 rounded-full font-bold';
        } else {
            filesBadge.className = 'text-xs bg-amber-100 text-amber-700 px-2.5 py-0.5 rounded-full font-bold';
        }
    }

    const kpiODLabel = document.getElementById('zipKpiODLabel');
    if (kpiODLabel) kpiODLabel.textContent = 'OD Files';

    const col1Header = document.getElementById('zipRegistryCol1Header');
    if (col1Header) col1Header.textContent = '1. OD File';

    const titleEl = document.getElementById('partyRegistryTableTitle');
    if (titleEl) titleEl.textContent = `${zipActivePlatform} Party Files Registry`;

    renderZipPlatformKPIs();
    populatePartySelectorDropdown();
    renderZipRegistryTable();
    
    // Refresh pipeline view if party was selected
    if (currentPipelinePartyCode) {
        selectPartyForPipeline(currentPipelinePartyCode);
    }
}

async function loadZipStatus(showToastMsg = false) {
    if (showToastMsg) showToast('Loading ZIP Status...', 'info');
    try {
        const res = await fetch('/api/zip/status');
        const result = await res.json();
        if (result.success && result.data) {
            zipStatusData = result.data;
            
            // Update total badge count on nav tab
            const tabCountEl = document.getElementById('tabCountZipBundles');
            if (tabCountEl) {
                tabCountEl.textContent = `${zipStatusData.total_parties}`;
            }

            renderZipPlatformKPIs();
            renderTopOverviewZipCounts();
            populatePartySelectorDropdown();
            renderZipRegistryTable();
            renderAllSheets(); // re-render checklist cards with zip badges
            
            if (showToastMsg) showToast(`ZIP status loaded (${zipStatusData.total_parties} parties across platforms)`, 'success');
        }
    } catch (e) {
        console.error('Error loading zip status:', e);
        if (showToastMsg) showToast('Failed to load ZIP status', 'error');
    }
}

function renderZipPlatformKPIs() {
    const pData = zipStatusData.platforms[zipActivePlatform] || { parties: [], stats: {} };
    const parties = pData.parties || [];
    
    let orderFileCount = 0;
    let twoMoreCount = 0;
    let detailsCount = 0;
    let summaryCount = 0;

    parties.forEach(p => {
        if (p.has_order_file || p.has_od || p.has_pr) orderFileCount++;
        if (p.has_two_more_invoice) twoMoreCount++;
        if (p.has_details) detailsCount++;
        if (p.has_summary) summaryCount++;
    });

    const elTotal = document.getElementById('zipKpiTotalParties');
    const elOD = document.getElementById('zipKpiODFiles');
    const elTwoMore = document.getElementById('zipKpiTwoMoreFiles');
    const elDetails = document.getElementById('zipKpiDetailsFiles');
    const elSummary = document.getElementById('zipKpiSummaryFiles');

    if (elTotal) elTotal.textContent = parties.length;
    if (elOD) elOD.textContent = orderFileCount;
    if (elTwoMore) elTwoMore.textContent = twoMoreCount;
    if (elDetails) elDetails.textContent = detailsCount;
    if (elSummary) elSummary.textContent = summaryCount;
}

function populatePartySelectorDropdown() {
    const sel = document.getElementById('quickPartySelector');
    if (!sel) return;
    
    const pData = zipStatusData.platforms[zipActivePlatform] || { parties: [] };
    const parties = pData.parties || [];
    
    sel.innerHTML = '<option value="">-- Choose Party Code --</option>';
    
    parties.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.party_code;
        const displayName = p.party_name ? `${p.party_code} - ${p.party_name}` : `Party ${p.party_code}`;
        const statusMark = p.is_complete ? '[Ready]' : (p.has_order_file || p.has_od || p.has_pr || p.has_details || p.has_summary) ? '[Partial]' : '[Pending]';
        opt.textContent = `${statusMark} ${displayName}`;
        if (p.party_code === currentPipelinePartyCode) {
            opt.selected = true;
        }
        sel.appendChild(opt);
    });
}

async function uploadPlatformZip(slotType, file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
        showToast('Please select a valid .zip file', 'error');
        return;
    }

    const setStatusHtml = (html) => {
        const el1 = document.getElementById(`zipUploadStatus-${slotType}`);
        if (el1) el1.innerHTML = html;
        document.querySelectorAll(`.zipUploadStatus-${slotType}`).forEach(el => {
            el.innerHTML = html;
        });
    };

    setStatusHtml(`<span class="text-indigo-600 font-semibold flex items-center gap-1.5"><i class="fa-solid fa-spinner fa-spin"></i> Uploading & extracting ${escapeHtml(file.name)}...</span>`);

    const formData = new FormData();
    formData.append('platform', zipActivePlatform);
    formData.append('zip_type', slotType);
    formData.append('file', file);

    try {
        const res = await fetch('/api/zip/upload', {
            method: 'POST',
            body: formData
        });
        const result = await res.json();
        
        if (result.success) {
            setStatusHtml(`<span class="text-emerald-600 font-bold flex items-center gap-1"><i class="fa-solid fa-check"></i> ${escapeHtml(result.message)}</span>`);
            showToast(result.message || 'ZIP uploaded successfully!', 'success');
            await loadZipStatus(false);
            
            // Auto select first updated party if none selected
            if (result.parties_updated && result.parties_updated.length > 0) {
                selectPartyForPipeline(result.parties_updated[0]);
            } else if (currentPipelinePartyCode) {
                selectPartyForPipeline(currentPipelinePartyCode);
            }
        } else {
            setStatusHtml(`<span class="text-rose-600 font-bold flex items-center gap-1"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(result.error || 'Upload failed')}</span>`);
            showToast(result.error || 'Failed to process ZIP', 'error');
        }
    } catch (e) {
        console.error(e);
        setStatusHtml(`<span class="text-rose-600 font-bold">Network error during upload</span>`);
        showToast('Network error uploading ZIP', 'error');
    }
}

async function selectPartyForPipeline(partyCode) {
    currentPipelinePartyCode = partyCode;
    const container = document.getElementById('partyPipelineDetailsContainer');
    if (!container) return;

    if (!partyCode) {
        container.innerHTML = `
            <div class="bg-slate-50 rounded-xl p-4 border border-slate-200/80 text-center text-slate-500 italic col-span-full py-6">
                <i class="fa-regular fa-hand-pointer mb-2 text-xl text-slate-400"></i>
                <p>Select a party code from the dropdown above to test file linking and automated dispatch.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="col-span-full text-center py-4 text-indigo-600 font-medium">
            <i class="fa-solid fa-spinner fa-spin text-base mr-2"></i> Fetching linked files for Party ${escapeHtml(partyCode)}...
        </div>
    `;

    try {
        const res = await fetch(`/api/zip/party_files?platform=${zipActivePlatform}&party_code=${encodeURIComponent(partyCode)}`);
        const json = await res.json();
        
        if (!json.success || !json.data) {
            container.innerHTML = `<div class="col-span-full text-center text-rose-500 font-medium">Error loading files for party ${escapeHtml(partyCode)}</div>`;
            return;
        }

        const b = json.data;
        const pTitle = b.party_name ? `${b.party_code} - ${b.party_name}` : `Party ${b.party_code}`;
        const ordType = b.order_file_type || 'OD';
        const targetOrderFile = b.order_file || b.od_file || b.pr_file;
        const hasOrderFile = Boolean(targetOrderFile);

        container.innerHTML = `
            <!-- Header for Selected Party -->
            <div class="col-span-full flex flex-wrap items-center justify-between pb-2.5 border-b border-indigo-100 gap-2">
                <div class="flex items-center space-x-2.5">
                    <span class="text-sm font-bold text-indigo-950">${escapeHtml(pTitle)}</span>
                    <span class="text-[11px] font-bold px-2 py-0.5 rounded-md border ${b.is_complete ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-amber-100 text-amber-800 border-amber-300'}">
                        <i class="fa-solid ${b.is_complete ? 'fa-circle-check text-emerald-600' : 'fa-circle-exclamation text-amber-600'} text-[10px] mr-1"></i>
                        ${b.is_complete ? 'All Core Files Ready' : 'Partial Files Attached'}
                    </span>
                </div>
                <a href="/api/zip/download_party_bundle/${b.platform}/${b.party_code}" class="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg shadow-indigo-600/20 shadow-2xs transition active:scale-95">
                    <i class="fa-solid fa-download text-xs"></i>
                    <span>Download All 4 as Bundle (.zip)</span>
                </a>
            </div>

            <!-- Slot 1: OD File (Emerald Theme) -->
            <div class="bg-emerald-50/40 rounded-xl p-3.5 border ${hasOrderFile ? 'border-emerald-300' : 'border-emerald-100'} shadow-2xs flex flex-col justify-between">
                <div>
                    <div class="flex items-center justify-between mb-1.5">
                        <span class="font-bold text-emerald-950 flex items-center gap-1.5 text-xs">
                            <i class="fa-regular fa-file-invoice ${hasOrderFile ? 'text-emerald-600' : 'text-slate-400'}"></i> 1. ${ordType} File
                        </span>
                        <span class="text-[10px] px-2 py-0.5 rounded font-bold ${hasOrderFile ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
                            ${hasOrderFile ? 'SAVED' : 'MISSING'}
                        </span>
                    </div>
                    <div class="font-mono text-xs ${hasOrderFile ? 'text-emerald-900 font-bold' : 'text-slate-400 italic'} truncate" title="${escapeHtml(targetOrderFile ? targetOrderFile.filename : 'Not available')}">
                        ${escapeHtml(targetOrderFile ? targetOrderFile.filename : `No ${ordType} file uploaded`)}
                    </div>
                </div>
                <div class="mt-2.5 pt-2 border-t border-emerald-100 flex items-center justify-between">
                    <span class="text-[10px] text-emerald-700/80 font-medium">Order Sheet</span>
                    ${hasOrderFile ? `
                        <a href="${targetOrderFile.download_url}" class="text-xs text-emerald-700 hover:text-emerald-900 font-bold flex items-center gap-1">
                            <i class="fa-solid fa-download text-[10px]"></i> Download
                        </a>
                    ` : `<span class="text-[10px] text-slate-400">Upload Order ZIP</span>`}
                </div>
            </div>

            <!-- Slot 2: 2 More Invoice (Amber Theme) -->
            <div class="bg-amber-50/40 rounded-xl p-3.5 border ${b.has_two_more_invoice ? 'border-amber-300' : 'border-amber-100'} shadow-2xs flex flex-col justify-between">
                <div>
                    <div class="flex items-center justify-between mb-1.5">
                        <span class="font-bold text-amber-950 flex items-center gap-1.5 text-xs">
                            <i class="fa-regular fa-file-circle-plus ${b.has_two_more_invoice ? 'text-amber-600' : 'text-slate-400'}"></i> 2. 2 More Invoice
                        </span>
                        <span class="text-[10px] px-2 py-0.5 rounded font-bold ${b.has_two_more_invoice ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-slate-100 text-slate-500 border border-slate-200'}">
                            ${b.has_two_more_invoice ? 'PRESENT' : 'OPTIONAL (SKIPPED)'}
                        </span>
                    </div>
                    <div class="font-mono text-xs ${b.has_two_more_invoice ? 'text-amber-900 font-bold' : 'text-slate-400 italic'} truncate" title="${escapeHtml(b.two_more_invoice ? b.two_more_invoice.filename : 'Not present in zip')}">
                        ${escapeHtml(b.two_more_invoice ? b.two_more_invoice.filename : 'None (Optional - Skipped)')}
                    </div>
                </div>
                <div class="mt-2.5 pt-2 border-t border-amber-100 flex items-center justify-between">
                    <span class="text-[10px] text-amber-700/80 font-medium">Invoice File</span>
                    ${b.has_two_more_invoice ? `
                        <a href="${b.two_more_invoice.download_url}" class="text-xs text-amber-700 hover:text-amber-900 font-bold flex items-center gap-1">
                            <i class="fa-solid fa-download text-[10px]"></i> Download
                        </a>
                    ` : `<span class="text-[10px] text-slate-400">Skipped Cleanly</span>`}
                </div>
            </div>

            <!-- Slot 3: Details File (Blue Theme) -->
            <div class="bg-blue-50/40 rounded-xl p-3.5 border ${b.has_details ? 'border-blue-300' : 'border-blue-100'} shadow-2xs flex flex-col justify-between">
                <div>
                    <div class="flex items-center justify-between mb-1.5">
                        <span class="font-bold text-blue-950 flex items-center gap-1.5 text-xs">
                            <i class="fa-regular fa-file-lines ${b.has_details ? 'text-blue-600' : 'text-slate-400'}"></i> 3. Details Sheet
                        </span>
                        <span class="text-[10px] px-2 py-0.5 rounded font-bold ${b.has_details ? 'bg-blue-100 text-blue-800 border border-blue-300' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
                            ${b.has_details ? 'SAVED' : 'MISSING'}
                        </span>
                    </div>
                    <div class="font-mono text-xs ${b.has_details ? 'text-blue-900 font-bold' : 'text-slate-400 italic'} truncate" title="${escapeHtml(b.details_file ? b.details_file.filename : 'Not available')}">
                        ${escapeHtml(b.details_file ? b.details_file.filename : 'No details file uploaded')}
                    </div>
                </div>
                <div class="mt-2.5 pt-2 border-t border-blue-100 flex items-center justify-between">
                    <span class="text-[10px] text-blue-700/80 font-medium">Details Bundle</span>
                    ${b.has_details ? `
                        <a href="${b.details_file.download_url}" class="text-xs text-blue-700 hover:text-blue-900 font-bold flex items-center gap-1">
                            <i class="fa-solid fa-download text-[10px]"></i> Download
                        </a>
                    ` : `<span class="text-[10px] text-slate-400">Upload Details ZIP</span>`}
                </div>
            </div>

            <!-- Slot 4: Summary File (Purple Theme) -->
            <div class="bg-purple-50/40 rounded-xl p-3.5 border ${b.has_summary ? 'border-purple-300' : 'border-purple-100'} shadow-2xs flex flex-col justify-between">
                <div>
                    <div class="flex items-center justify-between mb-1.5">
                        <span class="font-bold text-purple-950 flex items-center gap-1.5 text-xs">
                            <i class="fa-regular fa-file-shield ${b.has_summary ? 'text-purple-600' : 'text-slate-400'}"></i> 4. Summary Sheet
                        </span>
                        <span class="text-[10px] px-2 py-0.5 rounded font-bold ${b.has_summary ? 'bg-purple-100 text-purple-800 border border-purple-300' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
                            ${b.has_summary ? 'SAVED' : 'MISSING'}
                        </span>
                    </div>
                    <div class="font-mono text-xs ${b.has_summary ? 'text-purple-900 font-bold' : 'text-slate-400 italic'} truncate" title="${escapeHtml(b.summary_file ? b.summary_file.filename : 'Not available')}">
                        ${escapeHtml(b.summary_file ? b.summary_file.filename : 'No summary file uploaded')}
                    </div>
                </div>
                <div class="mt-2.5 pt-2 border-t border-purple-100 flex items-center justify-between">
                    <span class="text-[10px] text-purple-700/80 font-medium">Summary Bundle</span>
                    ${b.has_summary ? `
                        <a href="${b.summary_file.download_url}" class="text-xs text-purple-700 hover:text-purple-900 font-bold flex items-center gap-1">
                            <i class="fa-solid fa-download text-[10px]"></i> Download
                        </a>
                    ` : `<span class="text-[10px] text-slate-400">Upload Summary ZIP</span>`}
                </div>
            </div>
        `;
    } catch (e) {
        console.error(e);
        container.innerHTML = `<div class="col-span-full text-center text-rose-400">Failed to load party files</div>`;
    }
}

function filterZipRegistryTable(query) {
    zipRegistrySearchQuery = (query || '').toLowerCase().trim();
    renderZipRegistryTable();
}

function renderZipRegistryTable() {
    const tbody = document.getElementById('zipRegistryTableBody');
    if (!tbody) return;
    
    const pData = zipStatusData.platforms[zipActivePlatform] || { parties: [] };
    let parties = pData.parties || [];
    const orderLabel = 'OD';

    if (zipRegistrySearchQuery) {
        parties = parties.filter(p => 
            (p.party_code || '').toLowerCase().includes(zipRegistrySearchQuery) ||
            (p.party_name || '').toLowerCase().includes(zipRegistrySearchQuery)
        );
    }

    if (parties.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center py-10 text-slate-400">
                    <i class="fa-solid fa-folder-open text-3xl mb-2 text-slate-300"></i>
                    <p>No parties with ZIP files in <strong>${zipActivePlatform}</strong> yet.</p>
                    <p class="text-[11px] text-slate-400 mt-1">Upload Order ZIP, Details ZIP, or Summary ZIP above to populate.</p>
                </td>
            </tr>
        `;
        return;
    }

    let rowsHtml = '';
    parties.forEach(p => {
        const partyLabel = p.party_name ? `<strong>${escapeHtml(p.party_code)}</strong> - ${escapeHtml(p.party_name)}` : `<strong>${escapeHtml(p.party_code)}</strong>`;
        const targetOrderFile = p.order_file || p.od_file || p.pr_file;
        const hasOrder = Boolean(p.has_order_file || p.has_od || p.has_pr);
        const thisOrdType = p.order_file_type || orderLabel;

        const odCell = hasOrder && targetOrderFile ? `
            <div class="flex items-center justify-center gap-1">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px] border border-emerald-300">
                    <i class="fa-solid fa-check"></i> ${thisOrdType}
                </span>
                <a href="${targetOrderFile.download_url}" class="p-1 text-emerald-600 hover:text-emerald-800" title="${escapeHtml(targetOrderFile.filename)}">
                    <i class="fa-solid fa-download text-xs"></i>
                </a>
            </div>
        ` : `<span class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-100 text-[10px] font-medium">Missing</span>`;

        const twoMoreCell = p.has_two_more_invoice ? `
            <div class="flex items-center justify-center gap-1">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[10px] border border-amber-300">
                    <i class="fa-solid fa-check"></i> 2 More
                </span>
                <a href="${p.two_more_invoice.download_url}" class="p-1 text-amber-600 hover:text-amber-800" title="${escapeHtml(p.two_more_invoice.filename)}">
                    <i class="fa-solid fa-download text-xs"></i>
                </a>
            </div>
        ` : `<span class="text-slate-400 text-[10px] font-medium">Skipped (Opt)</span>`;

        const detailsCell = p.has_details ? `
            <div class="flex items-center justify-center gap-1">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-bold text-[10px] border border-blue-300">
                    <i class="fa-solid fa-check"></i> Details
                </span>
                <a href="${p.details_file.download_url}" class="p-1 text-blue-600 hover:text-blue-800" title="${escapeHtml(p.details_file.filename)}">
                    <i class="fa-solid fa-download text-xs"></i>
                </a>
            </div>
        ` : `<span class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-100 text-[10px] font-medium">Missing</span>`;

        const summaryCell = p.has_summary ? `
            <div class="flex items-center justify-center gap-1">
                <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-purple-100 text-purple-800 font-bold text-[10px] border border-purple-300">
                    <i class="fa-solid fa-check"></i> Summary
                </span>
                <a href="${p.summary_file.download_url}" class="p-1 text-purple-600 hover:text-purple-800" title="${escapeHtml(p.summary_file.filename)}">
                    <i class="fa-solid fa-download text-xs"></i>
                </a>
            </div>
        ` : `<span class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-100 text-[10px] font-medium">Missing</span>`;

        rowsHtml += `
            <tr class="hover:bg-indigo-50/30 transition">
                <td class="py-2.5 px-4 font-sans">
                    <div class="flex items-center space-x-2">
                        <button onclick="selectPartyForPipeline('${p.party_code}')" class="text-indigo-700 hover:text-indigo-900 font-bold text-xs cursor-pointer" title="Click to view linked files">
                            ${partyLabel}
                        </button>
                    </div>
                </td>
                <td class="py-2.5 px-4 text-center">${odCell}</td>
                <td class="py-2.5 px-4 text-center">${twoMoreCell}</td>
                <td class="py-2.5 px-4 text-center">${detailsCell}</td>
                <td class="py-2.5 px-4 text-center">${summaryCell}</td>
                <td class="py-2.5 px-4 text-center">
                    <a href="/api/zip/download_party_bundle/${p.platform}/${p.party_code}" class="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 transition active:scale-95 shadow-2xs" title="Download all available files for ${p.party_code} as zip">
                        <i class="fa-solid fa-file-zipper text-xs"></i> Bundle
                    </a>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = rowsHtml;
}

async function clearZipPlatformData() {
    const confirmed = await showCustomConfirm({
        title: `Clear ${zipActivePlatform} ZIP Storage?`,
        message: `This will remove all uploaded ZIP files, extracted files, 2 More Invoices, Details, and Summary sheets for ${zipActivePlatform}.\n\n🛡️ A full backup is automatically created.`,
        icon: 'fa-trash-can',
        iconColor: 'text-rose-600',
        iconBg: 'bg-rose-100',
        confirmText: `Clear ${zipActivePlatform} ZIPs`,
        confirmBtnClass: 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/30'
    });
    if (!confirmed) return;

    showToast(`Clearing ${zipActivePlatform} ZIP storage...`, 'info');

    try {
        const res = await fetch('/api/zip/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: zipActivePlatform })
        });
        const result = await res.json();
        if (result.success) {
            showToast(result.message || 'ZIP storage cleared!', 'success');
            await loadZipStatus(false);
            selectPartyForPipeline('');
        }
    } catch (e) {
        showToast('Error clearing ZIP storage', 'error');
    }
}

/* ==========================================================================
   TAX REPORTS SYSTEM (AUTO-RENAMING, 3-MONTH ROLLING, DRIVE SYNC)
   ========================================================================== */

let taxActivePlatform = 'AJIO';
let taxActiveMonth = '';
let taxAllData = {
    platforms: {},
    drive_configured: false,
    drive_status: 'Local Storage Only',
    drive_folder_id: ''
};
let taxSearchQuery = '';
let taxOldAccordionOpen = false;
let taxRenameState = { platform: '', month: '', old_filename: '' };

function getCurrentMonthCode() {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const now = new Date();
    return months[now.getMonth()];
}

function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function setupTaxDropzones() {
    ['AJIO', 'MYNTRA', 'FLIPKART'].forEach(plat => {
        const dropzone = document.getElementById(`taxDropzone-${plat}`);
        if (!dropzone) return;

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('ring-2', 'ring-amber-500', 'scale-[1.01]');
        });

        dropzone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('ring-2', 'ring-amber-500', 'scale-[1.01]');
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('ring-2', 'ring-amber-500', 'scale-[1.01]');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                uploadTaxReportFiles(plat, e.dataTransfer.files);
            }
        });
    });
}

function syncTaxMonthSelection(monthVal) {
    if (!monthVal) return;
    const val = monthVal.toLowerCase();
    const selFiles = document.getElementById('taxUploadMonthSelectFiles');
    if (selFiles && selFiles.value !== val) selFiles.value = val;
    taxActiveMonth = val;
    renderTaxMonthChips();
    renderTaxFilesTable();
}

async function loadTaxReports(showToastMsg = true) {
    if (showToastMsg) showToast('Loading Tax Reports...', 'info');
    try {
        const res = await fetch('/api/tax/data');
        const result = await res.json();
        if (!result.success) {
            if (showToastMsg) showToast(result.error || 'Failed to load tax data', 'error');
            return;
        }

        taxAllData = result.data || { platforms: {}, gdrive_status: {} };
        const gStatus = taxAllData.gdrive_status || {};
        updateTaxDriveBadge(gStatus.message, gStatus.connected);

        // Ensure active month is selected properly
        const validMonths = getValidPlatformMonths(taxActivePlatform);
        if (validMonths.length > 0) {
            if (!taxActiveMonth || !validMonths.includes(taxActiveMonth)) {
                taxActiveMonth = validMonths[0];
            }
        } else {
            taxActiveMonth = '';
        }

        const selFiles = document.getElementById('taxUploadMonthSelectFiles');
        if (selFiles && taxActiveMonth) selFiles.value = taxActiveMonth;

        renderTaxPlatformTabs();
        renderTaxMonthChips();
        renderTaxFilesTable();

        if (showToastMsg) showToast('Tax reports loaded', 'success');

        // Background sync check with Google Drive to keep manifest in sync
        fetch('/api/tax/sync_drive_structure', { method: 'POST' }).then(r => r.json()).then(dRes => {
            if (dRes && dRes.success) {
                // Background Drive structure verified
            }
        }).catch(() => {});
    } catch (err) {
        console.error(err);
        if (showToastMsg) showToast('Error connecting to tax API', 'error');
    }
}

function getValidPlatformMonths(platform) {
    const platMonthsObj = taxAllData.platforms?.[platform]?.months || {};
    return Object.keys(platMonthsObj).filter(m => {
        const d = platMonthsObj[m];
        return (d.files && d.files.length > 0) || (d.old_files && d.old_files.length > 0);
    });
}

function updateTaxDriveBadge(status, configured) {
    const badge = document.getElementById('taxDriveBadge');
    if (!badge) return;
    if (configured) {
        badge.className = 'text-[11px] px-2.5 py-0.5 rounded-full font-bold border bg-emerald-50 text-emerald-700 border-emerald-200 flex items-center gap-1 shadow-2xs';
        badge.innerHTML = '<i class="fa-solid fa-cloud-arrow-up text-emerald-600 text-[10px]"></i> Google Drive Synced';
    } else {
        badge.className = 'text-[11px] px-2.5 py-0.5 rounded-full font-bold border bg-slate-100 text-slate-700 border-slate-200 flex items-center gap-1';
        badge.innerHTML = '<i class="fa-solid fa-hard-drive text-slate-500 text-[10px]"></i> Local Storage Mode';
    }
}

function switchTaxPlatform(platform) {
    taxActivePlatform = platform;
    const validMonths = getValidPlatformMonths(taxActivePlatform);
    if (validMonths.length > 0) {
        if (!taxActiveMonth || !validMonths.includes(taxActiveMonth)) {
            taxActiveMonth = validMonths[0];
        }
    } else {
        taxActiveMonth = '';
    }
    const selFiles = document.getElementById('taxUploadMonthSelectFiles');
    if (selFiles && taxActiveMonth) selFiles.value = taxActiveMonth;

    renderTaxPlatformTabs();
    renderTaxMonthChips();
    renderTaxFilesTable();
}

function renderTaxPlatformTabs() {
    ['AJIO', 'MYNTRA', 'FLIPKART'].forEach(plat => {
        const btn = document.getElementById(`taxPlatBtn-${plat}`);
        if (!btn) return;
        const icon = btn.querySelector('i');
        const isActive = (taxActivePlatform === plat);
        if (isActive) {
            btn.className = `taxPlatBtn px-4 py-2 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-2xs text-white ${
                plat === 'AJIO' ? 'bg-purple-600' : (plat === 'MYNTRA' ? 'bg-blue-600' : 'bg-amber-600')
            }`;
            if (icon) {
                icon.className = icon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' text-white';
            }
        } else {
            btn.className = 'taxPlatBtn px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition flex items-center gap-1.5';
            if (icon) {
                const iconColor = plat === 'AJIO' ? 'text-purple-600' : (plat === 'MYNTRA' ? 'text-blue-600' : 'text-amber-600');
                icon.className = icon.className.replace(/text-[a-z]+-[0-9]+/g, '').replace('text-white', '').trim() + ' ' + iconColor;
            }
        }
    });
}

function renderTaxMonthChips() {
    const container = document.getElementById('taxMonthChipsContainer');
    if (!container) return;
    container.innerHTML = '';

    const platMonthsObj = taxAllData.platforms?.[taxActivePlatform]?.months || {};
    const validMonths = getValidPlatformMonths(taxActivePlatform);

    if (validMonths.length === 0) {
        container.innerHTML = `<span class="text-xs text-slate-400 italic px-2 py-1 flex items-center gap-1.5"><i class="fa-regular fa-folder-open text-slate-300"></i> No reports for ${taxActivePlatform}</span>`;
        return;
    }

    if (!taxActiveMonth || !validMonths.includes(taxActiveMonth)) {
        taxActiveMonth = validMonths[0];
    }

    validMonths.forEach(m => {
        const mLower = m.toLowerCase();
        const filesCount = platMonthsObj[mLower]?.files?.length || 0;
        const isActive = (mLower === taxActiveMonth);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.onclick = () => switchTaxMonth(mLower);

        if (isActive) {
            btn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-600 text-white shadow-2xs transition flex items-center gap-1.5 uppercase';
        } else {
            btn.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 transition flex items-center gap-1.5 uppercase';
        }

        btn.innerHTML = `<span>${m.toUpperCase()}</span> <span class="text-[10px] px-1.5 py-0.2 rounded-full ${isActive ? 'bg-amber-700 text-amber-100' : 'bg-slate-100 text-slate-600'}">${filesCount}</span>`;
        container.appendChild(btn);
    });
}

function switchTaxMonth(month) {
    taxActiveMonth = month.toLowerCase();
    const selFiles = document.getElementById('taxUploadMonthSelectFiles');
    if (selFiles) selFiles.value = taxActiveMonth;
    renderTaxMonthChips();
    renderTaxFilesTable();
}

function filterTaxTable(query) {
    taxSearchQuery = (query || '').toLowerCase().trim();
    renderTaxFilesTable();
}

function renderTaxFilesTable() {
    const tbody = document.getElementById('taxFilesTableBody');
    const badgeMonth = document.getElementById('taxActiveMonthBadge');
    const countEl = document.getElementById('taxActiveMonthCount');
    const zipBtn = document.getElementById('taxDownloadAllZipBtn');
    const delBtn = document.getElementById('taxDeleteAllBtn');
    const syncBtn = document.getElementById('taxSyncToDriveBtn');
    const syncBadge = document.getElementById('taxUnsyncedCountBadge');

    if (badgeMonth) badgeMonth.textContent = taxActiveMonth ? taxActiveMonth.toUpperCase() : 'NO DATA';

    const monthData = taxActiveMonth ? (taxAllData.platforms?.[taxActivePlatform]?.months?.[taxActiveMonth] || { files: [], old_files: [] }) : { files: [], old_files: [] };
    const allFiles = monthData.files || [];
    const oldFiles = monthData.old_files || [];

    // Filter files
    const filteredFiles = allFiles.filter(f => {
        if (!taxSearchQuery) return true;
        return (f.filename || '').toLowerCase().includes(taxSearchQuery) ||
               (f.party_code || '').toLowerCase().includes(taxSearchQuery);
    });

    const unsyncedFiles = allFiles.filter(f => !f.is_synced);
    const unsyncedCount = unsyncedFiles.length;

    if (syncBadge) {
        if (unsyncedCount > 0) {
            syncBadge.textContent = unsyncedCount;
            syncBadge.classList.remove('hidden');
        } else {
            syncBadge.classList.add('hidden');
        }
    }

    if (syncBtn) {
        if (allFiles.length === 0) {
            syncBtn.classList.add('opacity-50', 'pointer-events-none');
        } else {
            syncBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    }

    if (countEl) {
        if (!taxActiveMonth || allFiles.length === 0) {
            countEl.textContent = `0 files in ${taxActivePlatform}`;
        } else {
            countEl.textContent = `${allFiles.length} file${allFiles.length === 1 ? '' : 's'} in ${taxActiveMonth.toUpperCase()} (${taxActivePlatform}) • ${allFiles.length - unsyncedCount} synced, ${unsyncedCount} pending`;
        }
    }

    if (zipBtn) {
        if (allFiles.length === 0) {
            zipBtn.classList.add('opacity-50', 'pointer-events-none');
        } else {
            zipBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    }

    if (delBtn) {
        if (allFiles.length === 0 && oldFiles.length === 0) {
            delBtn.classList.add('opacity-50', 'pointer-events-none');
        } else {
            delBtn.classList.remove('opacity-50', 'pointer-events-none');
        }
    }

    if (!tbody) return;

    if (!taxActiveMonth || filteredFiles.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center py-12 text-slate-400">
                    <div class="flex flex-col items-center justify-center space-y-2">
                        <i class="fa-regular fa-folder-open text-3xl text-slate-300"></i>
                        <span class="text-xs font-semibold text-slate-600">${allFiles.length === 0 ? `No tax files found in ${taxActivePlatform}` : 'No matching files found'}</span>
                        <p class="text-[11px] text-slate-400">Upload tax Excel / CSV files above to organize into months.</p>
                    </div>
                </td>
            </tr>
        `;
        renderTaxOldFilesAccordion(oldFiles);
        return;
    }

    const platPillColor = taxActivePlatform === 'AJIO' 
        ? 'bg-purple-100 text-purple-800 border-purple-200' 
        : (taxActivePlatform === 'MYNTRA' ? 'bg-blue-100 text-blue-800 border-blue-200' : 'bg-amber-100 text-amber-800 border-amber-200');

        tbody.innerHTML = filteredFiles.map((f, idx) => {
            const escapedFn = encodeURIComponent(f.filename);
            const rawFnEscaped = f.filename.replace(/'/g, "\\'");
            const isSynced = Boolean(f.is_synced);

            // Red vs Green styling for filename and status badge
            const nameColorClass = isSynced ? 'text-emerald-700 font-bold' : 'text-rose-600 font-bold';
            const statusBadge = isSynced
                ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200"><i class="fa-solid fa-circle-check text-[9px]"></i> Synced</span>`
                : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200 animate-pulse"><i class="fa-solid fa-circle-exclamation text-[9px]"></i> Not Synced</span>`;

            // Drive icon in actions column
            const driveActionBtn = isSynced
                ? `<button type="button" class="p-1.5 text-emerald-600 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition" title="Synced to Google Drive (${f.synced_at || 'Synced'})">
                    <i class="fa-brands fa-google-drive text-xs"></i>
                   </button>`
                : `<button type="button" onclick="syncSingleFileRow('${taxActivePlatform}', '${taxActiveMonth}', '${rawFnEscaped}', this)" class="p-1.5 text-rose-600 bg-rose-50 hover:bg-rose-100 rounded-lg transition active:scale-95 shadow-2xs" title="Not synced to Google Drive. Click to sync this file now!">
                    <i class="fa-brands fa-google-drive text-xs"></i>
                   </button>`;

            return `
                <tr id="tax-row-${escapedFn}" class="hover:bg-slate-50/80 transition group ${!isSynced ? 'bg-rose-50/20' : ''}">
                    <td class="py-2.5 px-4 text-center text-slate-400 font-mono text-[11px]">${idx + 1}</td>
                    <td class="py-2.5 px-4 font-mono text-xs flex items-center gap-2">
                        <i class="fa-solid fa-file-excel ${isSynced ? 'text-emerald-600' : 'text-rose-500'} text-sm"></i>
                        <span class="truncate max-w-xs sm:max-w-md ${nameColorClass}" title="${f.filename}">${f.filename}</span>
                        ${statusBadge}
                    </td>
                    <td class="py-2.5 px-4 text-center">
                        <span class="inline-block px-2 py-0.5 rounded-md text-[11px] font-bold border ${platPillColor}">
                            ${f.party_code || '-'}
                        </span>
                    </td>
                    <td class="py-2.5 px-4 text-center text-slate-600 font-mono text-[11px]">${f.size_str || formatFileSize(f.size)}</td>
                    <td class="py-2.5 px-4 text-center text-slate-500 text-[11px]">${f.updated_at || '-'}</td>
                    <td class="py-2.5 px-4 text-center">
                        <div class="inline-flex items-center gap-1.5">
                            ${driveActionBtn}
                            <button onclick="openTaxRenameModal('${taxActivePlatform}', '${taxActiveMonth}', '${rawFnEscaped}')" class="p-1.5 text-slate-500 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition" title="Rename file">
                                <i class="fa-solid fa-pen-to-square text-xs"></i>
                            </button>
                            <a href="/api/tax/download/${taxActivePlatform}/${taxActiveMonth}/${escapedFn}" download class="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition" title="Download Excel">
                                <i class="fa-solid fa-download text-xs"></i>
                            </a>
                            <button onclick="deleteTaxReportFile('${taxActivePlatform}', '${taxActiveMonth}', '${rawFnEscaped}', false)" class="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition" title="Delete file">
                                <i class="fa-solid fa-trash text-xs"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

    // Render old / archived files accordion
    renderTaxOldFilesAccordion(oldFiles);
}

function renderTaxOldFilesAccordion(oldFiles) {
    const accordion = document.getElementById('taxOldFilesAccordion');
    const countEl = document.getElementById('taxOldCount');
    const tbody = document.getElementById('taxOldFilesTableBody');

    if (!accordion || !tbody) return;

    if (!oldFiles || oldFiles.length === 0) {
        accordion.classList.add('hidden');
        return;
    }

    accordion.classList.remove('hidden');
    if (countEl) countEl.textContent = oldFiles.length;

    tbody.innerHTML = oldFiles.map(f => {
        const escapedFn = encodeURIComponent(f.filename);
        const rawFnEscaped = f.filename.replace(/'/g, "\\'");
        return `
            <tr class="hover:bg-slate-100/80 transition">
                <td class="py-1.5 px-3 font-mono text-[11px] text-slate-700 flex items-center gap-2">
                    <i class="fa-solid fa-clock-rotate-left text-slate-400"></i>
                    <span class="truncate max-w-xs sm:max-w-md" title="${f.filename}">${f.filename}</span>
                </td>
                <td class="py-1.5 px-3 text-center text-slate-500 font-mono text-[11px]">${f.size_str || formatFileSize(f.size)}</td>
                <td class="py-1.5 px-3 text-center text-slate-400 text-[11px]">${f.archived_at || '-'}</td>
                <td class="py-1.5 px-3 text-center">
                    <div class="inline-flex items-center gap-1.5">
                        <a href="/api/tax/download/${taxActivePlatform}/${taxActiveMonth}/${escapedFn}?is_old=true" download class="p-1 text-slate-500 hover:text-blue-600 rounded transition" title="Download">
                            <i class="fa-solid fa-download text-xs"></i>
                        </a>
                        <button onclick="deleteTaxReportFile('${taxActivePlatform}', '${taxActiveMonth}', '${rawFnEscaped}', true)" class="p-1 text-slate-500 hover:text-rose-600 rounded transition" title="Delete permanently">
                            <i class="fa-solid fa-trash text-xs"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function toggleOldFilesAccordion() {
    const content = document.getElementById('taxOldFilesContent');
    const icon = document.getElementById('taxOldAccordionIcon');
    if (!content) return;

    taxOldAccordionOpen = !taxOldAccordionOpen;
    if (taxOldAccordionOpen) {
        content.classList.remove('hidden');
        if (icon) icon.classList.add('rotate-180');
    } else {
        content.classList.add('hidden');
        if (icon) icon.classList.remove('rotate-180');
    }
}

async function uploadTaxReportFiles(platform, files) {
    if (!files || files.length === 0) return;

    const selFiles = document.getElementById('taxUploadMonthSelectFiles');
    const month = (selFiles ? selFiles.value : taxActiveMonth) || getCurrentMonthCode();

    const statusEl = document.getElementById(`taxUploadStatus-${platform}`);
    if (statusEl) {
        statusEl.innerHTML = `<span class="text-amber-600 font-medium flex items-center gap-1.5"><i class="fa-solid fa-spinner fa-spin"></i> Processing & renaming ${files.length} file(s)...</span>`;
    }
    showToast(`Processing ${files.length} ${platform} tax report(s) for ${month.toUpperCase()}...`, 'info');

    const formData = new FormData();
    formData.append('platform', platform);
    formData.append('month', month);
    for (let i = 0; i < files.length; i++) {
        formData.append('files[]', files[i]);
        formData.append('files', files[i]);
    }

    try {
        const res = await fetch('/api/tax/upload', {
            method: 'POST',
            body: formData
        });
        const result = await res.json();

        // Reset file inputs
        const fileInput = document.getElementById(`taxFileInput-${platform}`);
        if (fileInput) fileInput.value = '';

        if (!result.success) {
            if (statusEl) {
                statusEl.innerHTML = `<span class="text-rose-600 font-medium"><i class="fa-solid fa-circle-xmark"></i> ${result.error || 'Upload failed'}</span>`;
            }
            showToast(result.error || 'Upload failed', 'error');
            return;
        }

        if (statusEl) {
            statusEl.innerHTML = `<span class="text-emerald-600 font-medium"><i class="fa-solid fa-circle-check"></i> ${result.uploaded_count} uploaded (${result.renamed_count} auto-renamed)</span>`;
            setTimeout(() => { if (statusEl) statusEl.innerHTML = ''; }, 6000);
        }

        showToast(`✅ Successfully processed ${result.uploaded_count} file(s) for ${platform} (${month.toUpperCase()})!`, 'success');

        taxActivePlatform = platform;
        taxActiveMonth = month;
        await loadTaxReports(false);
    } catch (err) {
        console.error(err);
        if (statusEl) {
            statusEl.innerHTML = `<span class="text-rose-600 font-medium"><i class="fa-solid fa-circle-xmark"></i> Network error</span>`;
        }
        showToast('Error uploading tax report files', 'error');
    }
}

function downloadActiveMonthZip() {
    if (!taxActivePlatform || !taxActiveMonth) {
        showToast('No active platform or month selected', 'error');
        return;
    }
    const monthData = taxAllData.platforms?.[taxActivePlatform]?.months?.[taxActiveMonth];
    if (!monthData || !monthData.files || monthData.files.length === 0) {
        showToast(`No files to download in ${taxActiveMonth.toUpperCase()} (${taxActivePlatform})`, 'error');
        return;
    }
    showToast(`Downloading ${taxActivePlatform} ${taxActiveMonth.toUpperCase()} ZIP bundle...`, 'info');
    window.location.href = `/api/tax/download_zip/${taxActivePlatform}/${taxActiveMonth}`;
}

function openTaxRenameModal(platform, month, filename) {
    taxRenameState = { platform, month, old_filename: filename };
    
    // Split name and extension
    const lastDotIdx = filename.lastIndexOf('.');
    const baseName = lastDotIdx !== -1 ? filename.substring(0, lastDotIdx) : filename;
    const ext = lastDotIdx !== -1 ? filename.substring(lastDotIdx) : '.csv';

    const modal = document.getElementById('taxRenameModal');
    const oldDisplay = document.getElementById('taxRenameOldDisplay');
    const inputNew = document.getElementById('taxRenameInputNew');
    const extLabel = document.getElementById('taxRenameExtLabel');
    const extHidden = document.getElementById('taxRenameExt');

    if (oldDisplay) oldDisplay.textContent = filename;
    if (inputNew) {
        inputNew.value = baseName;
        setTimeout(() => {
            inputNew.focus();
            inputNew.select();
        }, 100);
    }
    if (extLabel) extLabel.textContent = ext;
    if (extHidden) extHidden.value = ext;

    if (modal) modal.classList.remove('hidden');
}

function closeTaxRenameModal() {
    const modal = document.getElementById('taxRenameModal');
    if (modal) modal.classList.add('hidden');
    taxRenameState = { platform: '', month: '', old_filename: '' };
}

async function handleTaxRenameSubmit(e) {
    if (e) e.preventDefault();
    const inputNew = document.getElementById('taxRenameInputNew');
    const extHidden = document.getElementById('taxRenameExt');
    const ext = extHidden ? extHidden.value : '';
    let rawBase = inputNew ? inputNew.value.trim() : '';

    if (!rawBase) {
        showToast('Please enter a valid new file name', 'error');
        return;
    }

    // Strip accidental extension if typed by user
    if (ext && rawBase.toLowerCase().endsWith(ext.toLowerCase())) {
        rawBase = rawBase.substring(0, rawBase.length - ext.length);
    }

    const newFilename = `${rawBase}${ext}`;

    if (newFilename === taxRenameState.old_filename) {
        closeTaxRenameModal();
        return;
    }

    const submitBtn = document.getElementById('taxRenameSubmitBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Renaming...';
    }

    try {
        const res = await fetch('/api/tax/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platform: taxRenameState.platform,
                month: taxRenameState.month,
                old_filename: taxRenameState.old_filename,
                new_filename: newFilename
            })
        });
        const result = await res.json();
        if (result.success) {
            showToast('File renamed successfully!', 'success');
            closeTaxRenameModal();
            await loadTaxReports(false);
        } else {
            showToast(result.error || 'Failed to rename file', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Error during file rename', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save New Name';
        }
    }
}

async function deleteTaxReportFile(platform, month, filename, isOld = false) {
    const confirmed = await showCustomConfirm({
        title: 'Delete Tax Report File?',
        message: `Are you sure you want to delete "${filename}"?\n\nThis will permanently delete it locally and remove it from Google Drive.`,
        icon: 'fa-trash-can',
        iconColor: 'text-rose-600',
        iconBg: 'bg-rose-100',
        confirmText: 'Delete File',
        confirmBtnClass: 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/30'
    });
    if (!confirmed) return;

    showToast(`Deleting ${filename}...`, 'info');
    try {
        const res = await fetch('/api/tax/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, month, filename, is_old: isOld })
        });
        const result = await res.json();
        if (result.success) {
            showToast('File deleted successfully', 'success');
            await loadTaxReports(false);
        } else {
            showToast(result.error || 'Failed to delete file', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Error deleting file', 'error');
    }
}

async function confirmDeleteAllMonthFiles() {
    const platform = taxActivePlatform;
    const month = taxActiveMonth;
    if (!platform || !month) return;

    const pData = taxAllData?.platforms?.[platform];
    const mData = pData?.months?.[month];
    const activeCount = mData?.files_count || (mData?.files?.length || 0);
    const oldCount = mData?.old_files_count || (mData?.old_files?.length || 0);
    const totalCount = activeCount + oldCount;

    if (totalCount === 0) {
        showToast(`No files to delete in ${month.toUpperCase()} (${platform}).`, 'info');
        return;
    }

    const messageText = oldCount > 0
        ? `Are you sure you want to delete ALL files in ${month.toUpperCase()} (${platform})?\n\n• ${activeCount} active file(s)\n• ${oldCount} archived file(s) in 'old/'\n\n⚠️ This will permanently remove all ${totalCount} files from BOTH local server and Google Drive.`
        : `Are you sure you want to delete ALL ${activeCount} files in ${month.toUpperCase()} (${platform})?\n\n⚠️ This will permanently remove them from BOTH local server and Google Drive.`;

    const confirmed = await showCustomConfirm({
        title: `Delete All ${month.toUpperCase()} Files?`,
        message: messageText,
        icon: 'fa-trash-can',
        iconColor: 'text-rose-600',
        iconBg: 'bg-rose-100',
        confirmText: `Delete All (${totalCount} Files)`,
        confirmBtnClass: 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/30'
    });

    if (!confirmed) return;

    const delBtn = document.getElementById('taxDeleteAllBtn');
    let originalHtml = '';
    if (delBtn) {
        originalHtml = delBtn.innerHTML;
        delBtn.disabled = true;
        delBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
    }

    showToast(`Deleting all ${month.toUpperCase()} files locally and from Google Drive...`, 'info', 5000);

    try {
        const res = await fetch('/api/tax/delete_all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platform: platform,
                month: month,
                include_old: true
            })
        });
        const result = await res.json();
        if (result.success) {
            const driveMsg = result.gdrive_deleted ? 'and Google Drive' : '';
            showToast(`Successfully deleted ${result.deleted_count} files from local ${driveMsg}!`, 'success', 5000);
            await loadTaxReports(false);
        } else {
            showToast(result.error || 'Failed to delete files', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Error during bulk deletion', 'error');
    } finally {
        if (delBtn) {
            delBtn.disabled = false;
            delBtn.innerHTML = originalHtml;
        }
    }
}

const DRIVE_SETTINGS_PASSCODE = 'Ajx7';
let isDriveSettingsUnlocked = false;

function openGoogleDriveModal() {
    // If already unlocked during this session, open directly
    if (isDriveSettingsUnlocked) {
        showActualGoogleDriveModal();
        return;
    }

    const passModal = document.getElementById('drivePasscodeModal');
    const passInput = document.getElementById('drivePasscodeInput');
    const passError = document.getElementById('drivePasscodeError');

    if (passError) passError.classList.add('hidden');
    if (passInput) {
        passInput.value = '';
        passInput.classList.remove('border-rose-500');
    }

    if (passModal) {
        passModal.classList.remove('hidden');
        setTimeout(() => {
            if (passInput) passInput.focus();
        }, 100);
    } else {
        const entered = window.prompt('Enter Admin Passcode to open Drive Settings:');
        if (entered === DRIVE_SETTINGS_PASSCODE) {
            isDriveSettingsUnlocked = true;
            showActualGoogleDriveModal();
        } else if (entered !== null) {
            showToast('Access Denied: Incorrect passcode (case-sensitive)!', 'error');
        }
    }
}

function closeDrivePasscodeModal() {
    const passModal = document.getElementById('drivePasscodeModal');
    if (passModal) passModal.classList.add('hidden');
}

function verifyDrivePasscode(e) {
    if (e) e.preventDefault();
    const passInput = document.getElementById('drivePasscodeInput');
    const passError = document.getElementById('drivePasscodeError');
    const entered = passInput ? passInput.value : '';

    // Exact case-sensitive match
    if (entered === DRIVE_SETTINGS_PASSCODE) {
        isDriveSettingsUnlocked = true;
        closeDrivePasscodeModal();
        showToast('Access Granted! Opening Drive Settings...', 'success', 2000);
        showActualGoogleDriveModal();
    } else {
        if (passError) passError.classList.remove('hidden');
        if (passInput) {
            passInput.classList.add('border-rose-500');
            passInput.focus();
            passInput.select();
        }
        showToast('Access Denied: Incorrect passcode (case-sensitive)!', 'error');
    }
}

async function showActualGoogleDriveModal() {
    const modal = document.getElementById('taxDriveSettingsModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const statusTitle = document.getElementById('taxDriveModalStatusTitle');
    const statusDesc = document.getElementById('taxDriveModalStatusDesc');
    const statusIcon = document.getElementById('taxDriveModalStatusIcon');
    const statusBox = document.getElementById('taxDriveModalStatusBox');
    const folderInput = document.getElementById('taxDriveFolderIdInput');
    const gasInput = document.getElementById('taxDriveGasUrlInput');

    try {
        const res = await fetch('/api/tax/config');
        const data = await res.json();
        const cfg = data.config || {};
        const status = data.status || {};

        if (folderInput) folderInput.value = cfg.folder_id || '1aFmrWvPx-0QHkIkhieB-a9F2r9Zi8OOu';
        if (gasInput) gasInput.value = cfg.gas_url || '';

        if (cfg.gas_url) {
            statusBox.className = 'p-3.5 rounded-lg border flex items-center gap-3 bg-emerald-50 border-emerald-200 text-emerald-800';
            statusIcon.className = 'fa-solid fa-circle-check text-base text-emerald-600';
            statusTitle.textContent = 'Google Apps Script Connected & Active';
            statusDesc.textContent = `Direct user quota active. Files upload without any service account limits.`;
        } else if (status.connected) {
            statusBox.className = 'p-3.5 rounded-lg border flex items-center gap-3 bg-blue-50 border-blue-200 text-blue-800';
            statusIcon.className = 'fa-solid fa-circle-check text-base text-blue-600';
            statusTitle.textContent = 'Service Account Connected (Quota Limited)';
            statusDesc.textContent = `Tip: Add Google Apps Script Web App URL below for 100% unrestricted uploads.`;
        } else {
            statusBox.className = 'p-3.5 rounded-lg border flex items-center gap-3 bg-slate-50 border-slate-200 text-slate-700';
            statusIcon.className = 'fa-solid fa-circle-info text-base text-slate-400';
            statusTitle.textContent = 'Local Storage Mode';
            statusDesc.textContent = 'Follow the 1-minute steps below to connect Google Apps Script Web App for automatic Drive sync.';
        }
    } catch (e) {
        console.error(e);
    }
}

function closeGoogleDriveModal() {
    const modal = document.getElementById('taxDriveSettingsModal');
    if (modal) modal.classList.add('hidden');
}

async function saveGoogleDriveFolderId() {
    const folderInput = document.getElementById('taxDriveFolderIdInput');
    const gasInput = document.getElementById('taxDriveGasUrlInput');
    const folderId = folderInput ? folderInput.value.trim() : '';
    const gasUrl = gasInput ? gasInput.value.trim() : '';
    const saveBtn = document.getElementById('taxDriveSaveBtn');

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    }

    try {
        const res = await fetch('/api/tax/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_id: folderId, gas_url: gasUrl })
        });
        const result = await res.json();
        if (result.success) {
            showToast('Drive configuration saved successfully!', 'success');
            await loadTaxReports(false);
            showActualGoogleDriveModal(); // Refresh modal view
        } else {
            showToast(result.error || 'Failed to save config', 'error');
        }
    } catch (e) {
        showToast('Error connecting to Drive API', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save & Connect';
        }
    }
}

async function syncAllLocalFilesToDrive() {
    const syncBtn = document.getElementById('taxDriveSyncAllBtn');
    if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing local files to Drive...';
    }
    showToast('Starting sync of all local files to Google Drive...', 'info');

    try {
        const res = await fetch('/api/tax/sync_to_drive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: taxActivePlatform, month: taxActiveMonth })
        });
        const result = await res.json();
        if (result.success) {
            showToast(`✅ Successfully synced ${result.synced_count} file(s) to Google Drive!`, 'success');
            await loadTaxReports(false);
        } else {
            showToast(result.error || 'Sync failed', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Error connecting during Drive sync', 'error');
    } finally {
        if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i><span>Sync All Local Files to Drive Now</span>';
        }
    }
}

// -------------------------------------------------------------------------
// On-Demand Google Drive Sync with Progress Bar & Live Red-to-Green Transition
// -------------------------------------------------------------------------

let isBatchSyncRunning = false;
let shouldCancelBatchSync = false;

function cancelBatchSync() {
    shouldCancelBatchSync = true;
    const stepEl = document.getElementById('taxSyncProgressStep');
    if (stepEl) stepEl.textContent = 'Cancelling sync...';
}

async function syncSingleFileRow(platform, month, filename, btn) {
    if (!btn) return;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-xs text-blue-600"></i>';

    showToast(`Syncing "${filename}" to Google Drive...`, 'info', 3000);

    try {
        const res = await fetch('/api/tax/sync_file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, month, filename, is_old: false })
        });
        const result = await res.json();
        if (result.success) {
            showToast(`✅ "${filename}" synced to Google Drive!`, 'success');
            // Update in-memory state so it immediately turns green
            const mData = taxAllData.platforms?.[platform]?.months?.[month];
            if (mData && mData.files) {
                const fObj = mData.files.find(f => f.filename === filename);
                if (fObj) {
                    fObj.is_synced = true;
                    fObj.synced_at = new Date().toLocaleTimeString();
                }
            }
            renderTaxMonthChips();
            renderTaxFilesTable();
        } else {
            showToast(result.error || 'Failed to sync to Drive', 'error');
            btn.disabled = false;
            btn.innerHTML = origHtml;
        }
    } catch (err) {
        console.error(err);
        showToast('Error connecting during file sync', 'error');
        btn.disabled = false;
        btn.innerHTML = origHtml;
    }
}

async function startBatchSyncToDrive() {
    if (isBatchSyncRunning) return;

    const platform = taxActivePlatform;
    const month = taxActiveMonth;
    if (!platform || !month) return;

    const monthData = taxAllData.platforms?.[platform]?.months?.[month] || { files: [] };
    const allFiles = monthData.files || [];
    const pendingFiles = allFiles.filter(f => !f.is_synced);

    if (allFiles.length === 0) {
        showToast(`No files in ${month.toUpperCase()} (${platform}) to sync.`, 'info');
        return;
    }

    const filesToSync = pendingFiles.length > 0 ? pendingFiles : allFiles;

    // Open progress modal
    const modal = document.getElementById('taxSyncProgressModal');
    const bar = document.getElementById('taxSyncProgressBar');
    const percentEl = document.getElementById('taxSyncProgressPercent');
    const countEl = document.getElementById('taxSyncProgressCount');
    const stepEl = document.getElementById('taxSyncProgressStep');
    const fnEl = document.getElementById('taxSyncCurrentFilename');
    const cancelBtn = document.getElementById('taxSyncCancelBtn');

    if (modal) modal.classList.remove('hidden');
    isBatchSyncRunning = true;
    shouldCancelBatchSync = false;
    if (cancelBtn) cancelBtn.disabled = false;

    const total = filesToSync.length;
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < total; i++) {
        if (shouldCancelBatchSync) {
            showToast('Drive sync cancelled by user.', 'info');
            break;
        }

        const fileObj = filesToSync[i];
        const percent = Math.round(((i) / total) * 100);

        if (bar) bar.style.width = `${percent}%`;
        if (percentEl) percentEl.textContent = `${percent}%`;
        if (countEl) countEl.textContent = `${i + 1} / ${total}`;
        if (stepEl) stepEl.textContent = `Syncing file ${i + 1} of ${total}...`;
        if (fnEl) fnEl.textContent = fileObj.filename;

        try {
            const res = await fetch('/api/tax/sync_file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    platform: platform,
                    month: month,
                    filename: fileObj.filename,
                    is_old: false
                })
            });
            const result = await res.json();
            if (result.success) {
                completed++;
                fileObj.is_synced = true;
                fileObj.synced_at = new Date().toLocaleTimeString();
                // Dynamically update this row in UI without full reload
                renderTaxFilesTable();
            } else {
                failed++;
                console.error(`Failed to sync ${fileObj.filename}:`, result.error);
            }
        } catch (err) {
            failed++;
            console.error(`Error syncing ${fileObj.filename}:`, err);
        }
    }

    // Final 100% update
    if (bar) bar.style.width = '100%';
    if (percentEl) percentEl.textContent = '100%';
    if (stepEl) stepEl.textContent = failed > 0 ? `Completed with ${failed} error(s)` : 'All files synced!';

    setTimeout(() => {
        if (modal) modal.classList.add('hidden');
        isBatchSyncRunning = false;
        showToast(`✅ Successfully synced ${completed} file(s) to Google Drive!`, 'success');
        loadTaxReports(false);
    }, 800);
}
