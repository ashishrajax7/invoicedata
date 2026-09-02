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

    // 2. Fast background sync with server
    switchTab('zipbundles');
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
        btn.classList.remove('active', 'text-indigo-700', 'bg-indigo-50', 'border-indigo-200', 'text-emerald-700', 'bg-emerald-50', 'border-emerald-200', 'text-slate-900', 'bg-slate-100');
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
        } else {
            activeBtn.classList.add('active', 'text-slate-900', 'bg-slate-100');
        }
    }

    const panelEl = document.getElementById(`panel-${tabId}`);
    if (panelEl) panelEl.classList.remove('hidden');

    if (tabId === 'zipbundles') {
        loadZipStatus(false);
    }

    updateAddBtnLabel();
}

function switchSummarySubTab(subTabId) {
    activeSummarySubTab = subTabId;

    ['shortlist', 'partydetails', 'summary', 'uploadbox'].forEach(st => {
        const btn = document.getElementById(`subtab-${st}`);
        const panel = document.getElementById(`subpanel-${st}`);
        if (btn) {
            btn.classList.remove('active', 'bg-purple-600', 'bg-blue-600', 'bg-amber-600', 'bg-emerald-600', 'text-white', 'shadow-xs');
            btn.classList.add('text-slate-600');
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
    }

    if (activeSubpanel) {
        activeSubpanel.classList.remove('hidden');
    }

    updateAddBtnLabel();
}

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
    const myntraPr = myntra.pr_count !== undefined ? myntra.pr_count : (myntra.parties || []).filter(p => p.has_pr || p.has_order_file).length;
    const myntraTwoMore = myntra.two_more_count !== undefined ? myntra.two_more_count : (myntra.parties || []).filter(p => p.has_two_more_invoice).length;
    const myntraDetails = myntra.details_count !== undefined ? myntra.details_count : (myntra.parties || []).filter(p => p.has_details).length;
    const myntraSummary = myntra.summary_count !== undefined ? myntra.summary_count : (myntra.parties || []).filter(p => p.has_summary).length;

    const elMynPr = document.getElementById('myntraZipPrCount');
    if (elMynPr) elMynPr.textContent = myntraPr;
    const elMyn2M = document.getElementById('myntraZipTwoMoreCount');
    if (elMyn2M) elMyn2M.textContent = myntraTwoMore;
    const elMynDet = document.getElementById('myntraZipDetailsCount');
    if (elMynDet) elMynDet.textContent = myntraDetails;
    const elMynSum = document.getElementById('myntraZipSummaryCount');
    if (elMynSum) elMynSum.textContent = myntraSummary;

    // 3. FLIPKART
    const fk = platforms['FLIPKART'] || { parties: [] };
    const fkPr = fk.pr_count !== undefined ? fk.pr_count : (fk.parties || []).filter(p => p.has_pr || p.has_order_file).length;
    const fkTwoMore = fk.two_more_count !== undefined ? fk.two_more_count : (fk.parties || []).filter(p => p.has_two_more_invoice).length;
    const fkDetails = fk.details_count !== undefined ? fk.details_count : (fk.parties || []).filter(p => p.has_details).length;
    const fkSummary = fk.summary_count !== undefined ? fk.summary_count : (fk.parties || []).filter(p => p.has_summary).length;

    const elFkPr = document.getElementById('flipkartZipPrCount');
    if (elFkPr) elFkPr.textContent = fkPr;
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
        const isPRPlat = (pPlatform === 'MYNTRA' || pPlatform === 'FLIPKART');
        const zipParty = ((zipStatusData.platforms && zipStatusData.platforms[pPlatform]) ? zipStatusData.platforms[pPlatform].parties || [] : []).find(p => p.party_code === pCode);

        let zipPillsHtml = '';
        if (zipParty) {
            let pills = [];
            const hasOrd = zipParty.has_order_file || (isPRPlat ? zipParty.has_pr : zipParty.has_od) || zipParty.has_od || zipParty.has_pr;
            const ordLabel = isPRPlat ? 'PR' : 'OD';
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

async function uploadNewExcel(files) {
    if (!files || files.length === 0) return;
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
    }

    const statusEl = document.getElementById('uploadStatusMsg');
    statusEl.innerHTML = `<span class="text-indigo-600 font-semibold"><i class="fa-solid fa-spinner fa-spin"></i> Uploading ${files.length} file(s)...</span>`;

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
            statusEl.innerHTML = `<span class="text-emerald-600 font-semibold">Uploaded ${data.saved_files ? data.saved_files.length : 1} file(s)! Reloading...</span>`;
            loadData('__all__', true);
        } else {
            statusEl.innerHTML = `<span class="text-rose-600 font-semibold">${data.error || 'Upload failed'}</span>`;
        }
    } catch (e) {
        statusEl.innerHTML = `<span class="text-rose-600 font-semibold">Network error during upload</span>`;
    }
}

function renderLoadedFilesList() {
    const container = document.getElementById('loadedFilesList');
    if (!container) return;
    container.innerHTML = '';

    if (!appData.available_files || appData.available_files.length === 0) {
        container.innerHTML = `<div class="text-slate-400 italic py-2">No files currently active. Upload new files above.</div>`;
        return;
    }

    (appData.available_files || []).forEach(f => {
        let tag = 'General';
        let color = 'bg-slate-100 text-slate-700';
        if (f.toUpperCase().includes('REPORT')) {
            tag = 'AJIO';
            color = 'bg-purple-100 text-purple-800';
        } else if (f.toUpperCase().includes('SUMMARY') && !f.toUpperCase().includes('FK')) {
            tag = 'Myntra';
            color = 'bg-blue-100 text-blue-800';
        } else if (f.toUpperCase().includes('FK')) {
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
    const isPR = (zipActivePlatform === 'MYNTRA' || zipActivePlatform === 'FLIPKART');
    const orderTypeLabel = isPR ? 'PR' : 'OD';
    
    // Update platform button styles
    ['AJIO', 'MYNTRA', 'FLIPKART'].forEach(p => {
        const btn = document.getElementById(`zipPlatformBtn-${p}`);
        if (btn) {
            if (p === zipActivePlatform) {
                if (p === 'AJIO') {
                    btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-purple-600 text-white shadow-sm';
                } else if (p === 'MYNTRA') {
                    btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-blue-600 text-white shadow-sm';
                } else {
                    btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-amber-600 text-white shadow-sm';
                }
            } else {
                btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-700/60 transition flex items-center gap-1.5';
            }
        }
    });

    const badge = document.getElementById('zipPlatformBadge');
    if (badge) {
        badge.textContent = zipActivePlatform;
        if (zipActivePlatform === 'AJIO') {
            badge.className = 'text-xs bg-purple-500/30 text-purple-200 border border-purple-400/40 px-3 py-0.5 rounded-full font-bold';
        } else if (zipActivePlatform === 'MYNTRA') {
            badge.className = 'text-xs bg-blue-500/30 text-blue-200 border border-blue-400/40 px-3 py-0.5 rounded-full font-bold';
        } else {
            badge.className = 'text-xs bg-amber-500/30 text-amber-200 border border-amber-400/40 px-3 py-0.5 rounded-full font-bold';
        }
    }

    // Dynamic Slot 1 Labels based on platform across all sections
    document.querySelectorAll('.zipSlot1Title, #zipSlot1Title').forEach(el => {
        el.textContent = isPR ? 'Processed ZIP (PR + 2 More)' : 'Order ZIP (OD + 2 More)';
    });

    document.querySelectorAll('.zipSlot1Desc, #zipSlot1Desc').forEach(el => {
        const exampleZip = isPR ? '139-157 process.zip' : '101-157_processed.zip';
        el.innerHTML = `Upload processed zip (e.g. <code class="bg-slate-100 px-1 py-0.5 rounded text-slate-700">${exampleZip}</code>). Auto-saves ${orderTypeLabel} and 2 More Invoice (optional).`;
    });

    document.querySelectorAll('.zipSlot1DropText, #zipSlot1DropText').forEach(el => {
        el.textContent = `Select or Drop ${isPR ? 'Processed' : 'Order'} .zip (${orderTypeLabel} file)`;
    });

    // Update secondary platform switcher buttons
    ['AJIO', 'MYNTRA', 'FLIPKART'].forEach(p => {
        const btn = document.getElementById(`filesZipBtn-${p}`);
        if (btn) {
            if (p === zipActivePlatform) {
                if (p === 'AJIO') btn.className = 'filesZipPlatBtn px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-purple-600 text-white shadow-xs';
                else if (p === 'MYNTRA') btn.className = 'filesZipPlatBtn px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-blue-600 text-white shadow-xs';
                else btn.className = 'filesZipPlatBtn px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-amber-600 text-white shadow-xs';
            } else {
                btn.className = 'filesZipPlatBtn px-3.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition flex items-center gap-1.5';
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
    if (kpiODLabel) kpiODLabel.textContent = `${orderTypeLabel} Files`;

    const col1Header = document.getElementById('zipRegistryCol1Header');
    if (col1Header) col1Header.textContent = `1. ${orderTypeLabel} File`;

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
    const isPR = (zipActivePlatform === 'MYNTRA' || zipActivePlatform === 'FLIPKART');
    
    let orderFileCount = 0;
    let twoMoreCount = 0;
    let detailsCount = 0;
    let summaryCount = 0;

    parties.forEach(p => {
        if (p.has_order_file || (isPR ? p.has_pr : p.has_od) || p.has_od || p.has_pr) orderFileCount++;
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
        const isPR = (zipActivePlatform === 'MYNTRA' || zipActivePlatform === 'FLIPKART');
        const ordType = b.order_file_type || (isPR ? 'PR' : 'OD');
        const targetOrderFile = b.order_file || (isPR ? b.pr_file : b.od_file) || b.od_file || b.pr_file;
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

            <!-- Slot 1: OD / PR File (Emerald Theme) -->
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
                    <span class="text-[10px] text-emerald-700/80 font-medium">${isPR ? 'Processed Sheet' : 'Order Sheet'}</span>
                    ${hasOrderFile ? `
                        <a href="${targetOrderFile.download_url}" class="text-xs text-emerald-700 hover:text-emerald-900 font-bold flex items-center gap-1">
                            <i class="fa-solid fa-download text-[10px]"></i> Download
                        </a>
                    ` : `<span class="text-[10px] text-slate-400">Upload ${isPR ? 'Processed' : 'Order'} ZIP</span>`}
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
    const isPR = (zipActivePlatform === 'MYNTRA' || zipActivePlatform === 'FLIPKART');
    const orderLabel = isPR ? 'PR' : 'OD';

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
                    <p class="text-[11px] text-slate-400 mt-1">Upload ${isPR ? 'Processed' : 'Order'} ZIP, Details ZIP, or Summary ZIP above to populate.</p>
                </td>
            </tr>
        `;
        return;
    }

    let rowsHtml = '';
    parties.forEach(p => {
        const partyLabel = p.party_name ? `<strong>${escapeHtml(p.party_code)}</strong> - ${escapeHtml(p.party_name)}` : `<strong>${escapeHtml(p.party_code)}</strong>`;
        const targetOrderFile = p.order_file || (isPR ? p.pr_file : p.od_file) || p.od_file || p.pr_file;
        const hasOrder = Boolean(p.has_order_file || (isPR ? p.has_pr : p.has_od) || p.has_od || p.has_pr);
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
