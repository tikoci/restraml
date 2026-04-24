// =====================================================================
// restraml-shared.js — Shared utilities for all docs/*.html tool pages
//
// AGENTS: This file contains code shared across ALL tool pages.
// Page-specific logic stays inline in each HTML file.
// When adding a new docs/*.html page, include this via:
//   <script src="restraml-shared.js"></script>
// Then call initThemeSwitcher() and optionally initShareModal({...}).
//
// When modifying shared behavior, change THIS file — not inline copies.
// If you find duplicated logic inline in an HTML file, extract it here.
// =====================================================================

// --- Project constants -----------------------------------------------
const RESTRAML = Object.freeze({
    owner: 'tikoci',
    repo: 'restraml',
    pagesUrl: 'https://tikoci.github.io/restraml',
    apiContentsUrl: 'https://api.github.com/repos/tikoci/restraml/contents/docs',
})

// --- Brand gradient (random MikroTik-inspired gradient per page load) -
// Synced with tikoci.github.io shared.js. Runs immediately — no DOM needed.
const _BRAND_GRADIENTS = [
    ['#C33366', '#692878'],
    ['#EE9B01', '#EE4F01'],
    ['#3660B9', '#5F2965'],
    ['#3BB5B6', '#44DE95'],
    ['#582D7C', '#1FC8DB'],
    ['#CF0F14', '#EE4F01'],
    ['#1F417A', '#87D3DB'],
    ['#015EA4', '#3BB5B6'],
    ['#017C65', '#A3D16E'],
    ['#692878', '#1FC8DB'],
];
(() => {
    const p = _BRAND_GRADIENTS[Math.floor(Math.random() * _BRAND_GRADIENTS.length)];
    document.documentElement.style.setProperty(
        '--brand-gradient', `linear-gradient(135deg, ${p[0]}, ${p[1]})`
    );
})();

// --- RouterOS version parsing and sorting ----------------------------

/**
 * Parse a RouterOS version string into a comparable structure.
 * Examples: "7.22" -> {major:7, minor:22, patch:0, pre:"", preNum:Infinity}
 *           "7.22rc2" -> {major:7, minor:22, patch:0, pre:"rc", preNum:2}
 *           "7.21beta11" -> {major:7, minor:21, patch:0, pre:"beta", preNum:11}
 *           "7.15.3" -> {major:7, minor:15, patch:3, pre:"", preNum:Infinity}
 */
function parseVersion(str) {
    const m = str.match(/^(\d+)\.(\d+)(?:\.(\d+))?(beta|rc)?(\d+)?$/)
    if (!m) return null
    return {
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3] || '0', 10),
        pre: m[4] || '',
        preNum: m[5] ? parseInt(m[5], 10) : (m[4] ? 0 : Infinity)
    }
}

/**
 * Compare two version strings for sorting (descending: newest first).
 */
function compareVersions(a, b) {
    const va = parseVersion(a)
    const vb = parseVersion(b)
    if (!va && !vb) return a.localeCompare(b)
    if (!va) return 1
    if (!vb) return -1
    if (va.major !== vb.major) return vb.major - va.major
    if (va.minor !== vb.minor) return vb.minor - va.minor
    if (va.patch !== vb.patch) return vb.patch - va.patch
    // Stable (preNum=Infinity) sorts before pre-releases
    if (va.preNum !== vb.preNum) return vb.preNum - va.preNum
    return 0
}

/**
 * Returns true if the version is a pre-release (beta or rc).
 */
function isPreRelease(name) {
    return /(?:beta|rc)\d*$/.test(name)
}

/**
 * Rebuild a <select> element's options from a sorted version list.
 * Safari does not support `option.hidden`, so we add/remove options instead.
 * Preserves the current selection if still present.
 */
function rebuildSelect(sel, versions, showAll) {
    const selectedVal = sel.value
    // Remove all non-placeholder options
    while (sel.options.length > 1) sel.remove(1)
    versions.forEach(name => {
        if (showAll || !isPreRelease(name)) {
            sel.appendChild(new Option(name, name))
        }
    })
    // Restore selection if the value is still in the list
    if ([...sel.options].some(o => o.value === selectedVal)) {
        sel.value = selectedVal
    }
}

// --- GitHub API: fetch version directory listing ---------------------
// Cached in localStorage to minimise GitHub API calls (60/hour unauth).
// All docs/*.html pages share this cache via the same origin.
// On 403 (rate limited), falls back to stale cache if available.

const _VER_CACHE_KEY = 'restraml_versions'
const _VER_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/** In-memory promise so concurrent calls within the same page share one request. */
let _verListPromise = null

/**
 * Fetch the list of built versions from the GitHub API.
 * Returns a promise resolving to an array of GitHub content objects,
 * sorted newest-first by version. Each has { name, path, type, ... }.
 *
 * Results are cached in localStorage for 5 minutes to reduce API calls
 * across page navigations (all docs pages share the same GH Pages origin).
 * On 403 (rate limited), falls back to stale cache regardless of TTL.
 */
function fetchVersionList() {
    if (_verListPromise) return _verListPromise
    _verListPromise = _fetchVersionListInner()
    // Clear the in-memory dedup after settling so future calls can retry
    _verListPromise.finally(() => { _verListPromise = null })
    return _verListPromise
}

function _fetchVersionListInner() {
    // Check localStorage cache first
    try {
        const raw = localStorage.getItem(_VER_CACHE_KEY)
        if (raw) {
            const cached = JSON.parse(raw)
            if (cached?.ts && Date.now() - cached.ts < _VER_CACHE_TTL) {
                return Promise.resolve(cached.data)
            }
        }
    } catch { /* ignore corrupted cache */ }

    return fetch(RESTRAML.apiContentsUrl)
        .then(r => {
            if (r.status === 403) {
                // Rate limited — try stale cache regardless of TTL
                const stale = _readStaleVersionCache()
                if (stale) return stale
                throw new Error(`GitHub API returned 403 (rate limited) — no cached version list available`)
            }
            if (!r.ok) throw new Error(`GitHub API returned ${r.status} ${r.statusText}`)
            return r.json()
        })
        .then(data => {
            if (!Array.isArray(data)) throw new Error('Unexpected GitHub API response')
            const versions = data
                .filter(f => f.type === 'dir' && f.name !== 'extra')
                .sort((a, b) => compareVersions(a.name, b.name))
            // Persist to localStorage
            try {
                localStorage.setItem(_VER_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: versions }))
            } catch { /* storage full or unavailable */ }
            return versions
        })
}

function _readStaleVersionCache() {
    try {
        const raw = localStorage.getItem(_VER_CACHE_KEY)
        if (raw) {
            const cached = JSON.parse(raw)
            if (cached && Array.isArray(cached.data) && cached.data.length > 0) {
                return cached.data
            }
        }
    } catch { /* ignore */ }
    return null
}

// --- Dark mode theme switcher ----------------------------------------
// Cycles through: auto → light → dark → auto
//
// CRITICAL Pico CSS v2 gotcha: data-theme="auto" is NOT a valid value.
// Setting it silently forces light mode. For the "auto" (OS-following)
// state, REMOVE the data-theme attribute entirely so Pico's
// @media (prefers-color-scheme: dark) rules apply natively.
// =====================================================================

const _THEME_ICONS = {
    sun: '<svg width="23px" height="23px" viewBox="0 0 16 16"><path fill="currentColor" d="M8 11a3 3 0 1 1 0-6a3 3 0 0 1 0 6zm0 1a4 4 0 1 0 0-8a4 4 0 0 0 0 8zM8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0zm0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13zm8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5zM3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8zm10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0zm-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0zm9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707zM4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708z"/></svg>',
    moon: '<svg width="23px" height="23px" viewBox="0 0 16 16"><g fill="currentColor"><path d="M6 .278a.768.768 0 0 1 .08.858a7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277c.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316a.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71C0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278zM4.858 1.311A7.269 7.269 0 0 0 1.025 7.71c0 4.02 3.279 7.276 7.319 7.276a7.316 7.316 0 0 0 5.205-2.162c-.337.042-.68.063-1.029.063c-4.61 0-8.343-3.714-8.343-8.29c0-1.167.242-2.278.681-3.286z"/><path d="M10.794 3.148a.217.217 0 0 1 .412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 0 1 0 .412l-1.162.387a1.734 1.734 0 0 0-1.097 1.097l-.387 1.162a.217.217 0 0 1-.412 0l-.387-1.162A1.734 1.734 0 0 0 9.31 6.593l-1.162-.387a.217.217 0 0 1 0-.412l1.162-.387a1.734 1.734 0 0 0 1.097-1.097l.387-1.162zM13.863.099a.145.145 0 0 1 .274 0l.258.774c.115.346.386.617.732.732l.774.258a.145.145 0 0 1 0 .274l-.774.258a1.156 1.156 0 0 0-.732.732l-.258.774a.145.145 0 0 1-.274 0l-.258-.774a1.156 1.156 0 0 0-.732-.732l-.774-.258a.145.145 0 0 1 0-.274l.774-.258c.346-.115.617-.386.732-.732L13.863.1z"/></g></svg>',
    osDefault: '<svg width="23px" height="23px" viewBox="0 0 16 16"><path fill="currentColor" d="M8 15A7 7 0 1 0 8 1v14zm0 1A8 8 0 1 1 8 0a8 8 0 0 1 0 16z"/></svg>',
}

/**
 * Initialize the 3-state theme switcher on a page.
 * Expects an <a id="theme_switcher"> element in the DOM.
 * Call this once per page, after the DOM element exists.
 */
function initThemeSwitcher(id) {
    id = id || 'theme_switcher'
    const html = document.documentElement
    const el = document.getElementById(id)
    let state = 'auto'

    document.addEventListener('DOMContentLoaded', () => {
        el.innerHTML = _THEME_ICONS.osDefault
    })

    el.addEventListener('click', e => {
        e.preventDefault()
        if (state === 'auto') {
            state = 'light'
            html.setAttribute('data-theme', 'light')
            el.innerHTML = _THEME_ICONS.sun
        } else if (state === 'light') {
            state = 'dark'
            html.setAttribute('data-theme', 'dark')
            el.innerHTML = _THEME_ICONS.moon
        } else {
            state = 'auto'
            html.removeAttribute('data-theme') // No attribute = Pico follows OS
            el.innerHTML = _THEME_ICONS.osDefault
        }
    })
}

// --- Changelog / Release Notes modal ---------------------------------

/**
 * HTML-escape a string for safe insertion into innerHTML.
 */
function _clEscapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escape a string for use as a regex literal.
 */
function _clEscapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * HTML-escape `str` then wrap all occurrences of `query` in a highlight <mark>.
 */
function _clHighlight(str, query) {
    if (!query) return _clEscapeHtml(str)
    const safe = _clEscapeHtml(str)
    return safe.replace(new RegExp(`(${_clEscapeRegex(query)})`, 'gi'), '<mark class="cl-highlight">$1</mark>')
}

/**
 * Parse a single RouterOS changelog entry line.
 *
 * @param {string} line
 * @returns {{raw: string, important: boolean, secure: boolean, subsystem: string, text: string} | null}
 */
function parseChangelogEntry(line) {
    const trimmed = line.trim()
    if (!/^[*!]\)/.test(trimmed)) return null

    const important = trimmed.startsWith('!)')
    const body = trimmed.replace(/^[*!]\)\s*/, '')
    const dashIdx = body.indexOf(' - ')
    let subsystem = ''
    let text = body

    if (dashIdx > 0 && dashIdx < 30) {
        subsystem = body.substring(0, dashIdx).trim()
        text = body.substring(dashIdx + 3)
    }

    return {
        raw: trimmed,
        important,
        secure: /security|vulnerabilit|CVE-/i.test(trimmed),
        subsystem,
        text,
    }
}

/**
 * Render one parsed changelog entry to HTML.
 *
 * @param {{important: boolean, secure: boolean, subsystem: string, text: string}} entry
 * @param {string} query
 * @returns {string}
 */
function renderChangelogEntryHtml(entry, query) {
    const subsystemHtml = entry.subsystem
        ? `<span class="cl-subsystem">${_clEscapeHtml(entry.subsystem)}</span>`
        : ''
    const cls = `cl-item${(entry.secure || entry.important) ? ' cl-item-important' : ''}`
    return `<span class="${cls}">${subsystemHtml}<span class="cl-text">${_clHighlight(entry.text, query)}</span></span>`
}

/**
 * Parse RouterOS CHANGELOG text into per-version sections.
 *
 * @param {string} rawText
 * @returns {{version: string, date: string, heading: string, entries: Array<{raw: string, important: boolean, secure: boolean, subsystem: string, text: string}>}[]}
 */
function parseChangelogSections(rawText) {
    const sections = []
    let current = null

    for (const line of rawText.split('\n')) {
        const trimmed = line.trim()
        const headerMatch = trimmed.match(/^What's new in ([^\s]+) \(([^)]+)\):/i)
        if (headerMatch) {
            if (current) sections.push(current)
            current = {
                version: headerMatch[1],
                date: headerMatch[2],
                heading: trimmed,
                entries: [],
            }
            continue
        }

        if (!current) continue
        const entry = parseChangelogEntry(trimmed)
        if (entry) current.entries.push(entry)
    }

    if (current) sections.push(current)
    return sections
}

/**
 * Render MikroTik CHANGELOG text into `contentEl`.
 * Items starting with "!)" are highlighted in red (important/breaking).
 *
 * @param {string} rawText       - Raw CHANGELOG text
 * @param {string} targetVersion - Version whose section should be scrolled into view
 * @param {string} query         - Filter string (empty = show all)
 * @param {HTMLElement} contentEl   - The element to render into
 * @param {HTMLElement} itemCountEl - The element to show item count in
 */
function renderChangelogContent(rawText, targetVersion, query, contentEl, itemCountEl) {
    const lines = rawText.split('\n')
    const q = query ? query.toLowerCase() : ''

    let html = ''
    let totalItems = 0
    let visibleItems = 0
    let prevBlank = false

    for (const line of lines) {
        const trimmed = line.trim()

        // Section header: "What's new in X.X (date):"
        if (/^What's new in /i.test(trimmed)) {
            const vPart = trimmed.replace(/^What's new in /i, '').split(' ')[0]
            const isTarget = vPart === targetVersion
            const id = isTarget ? 'cl-current-section' : ''
            const cls = isTarget ? 'cl-section-header cl-section-current' : 'cl-section-header'
            if (!q || trimmed.toLowerCase().includes(q)) {
                html += `<span${id ? ` id="${id}"` : ''} class="${cls}">${_clEscapeHtml(trimmed)}</span>`
            }
            prevBlank = false
            continue
        }

        // Changelog item: "*)" regular item, "!)" important/breaking item (red)
        if (/^[*!]\)/.test(trimmed)) {
            const entry = parseChangelogEntry(trimmed)
            totalItems++
            const isMatch = !q || trimmed.toLowerCase().includes(q)
            if (isMatch) {
                visibleItems++
                html += renderChangelogEntryHtml(entry, query)
            }
            prevBlank = false
            continue
        }

        // Blank lines: insert a spacer (but collapse multiples)
        if (!trimmed) {
            if (!prevBlank && !q) html += '<br>'
            prevBlank = true
            continue
        }
        prevBlank = false
    }

    if (!html.trim()) {
        contentEl.innerHTML = '<p style="opacity:0.6; padding:2rem; text-align:center"><em>No matching entries found.</em></p>'
    } else {
        contentEl.innerHTML = html
    }

    if (q) {
        itemCountEl.textContent = `${visibleItems} of ${totalItems} entries match "${query}"`
    } else {
        itemCountEl.textContent = `${totalItems} total entries`
    }

    // Scroll the target version's section into view
    if (!q) {
        const targetEl = contentEl.querySelector('#cl-current-section')
        if (targetEl) {
            setTimeout(() => targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
        }
    }
}

/**
 * Initialize the Changelog / Release Notes modal on a page.
 * Expects <dialog id="changelog-modal"> with the standard inner structure.
 *
 * @param {Object}            opts
 * @param {function(): string[]}  opts.getVersions  - Returns all known version names, newest-first
 * @param {function(): boolean}   opts.includePre   - Returns true when pre-releases should be
 *                                                    included in the diff-link "previous version" search
 * @param {string}               [opts.diffPage]    - Relative URL of the diff page (default: 'diff.html')
 * @returns {{ showChangelog: function(version: string): void }}
 */
function initChangelogModal(opts) {
    const modal = document.getElementById('changelog-modal')
    if (!modal) return { showChangelog: () => {} }

    const diffPage = opts.diffPage || 'diff.html'
    const contentEl    = document.getElementById('changelog-content')
    const titleEl      = document.getElementById('changelog-title')
    const subtitleEl   = document.getElementById('changelog-subtitle')
    const mikrotikLink = document.getElementById('changelog-mikrotik-link')
    const searchEl     = document.getElementById('changelog-search')
    const itemCountEl  = document.getElementById('changelog-item-count')
    const diffLinkEl   = document.getElementById('changelog-diff-link')

    let _fontSizeRem = 0.82  // rem, matches CSS default
    let _rawText = ''
    let _version = ''

    document.getElementById('changelog-close').addEventListener('click', () => modal.close())
    modal.addEventListener('click', e => { if (e.target === modal) modal.close() })

    document.getElementById('changelog-font-dec').addEventListener('click', () => {
        _fontSizeRem = Math.max(0.6, _fontSizeRem - 0.08)
        contentEl.style.fontSize = `${_fontSizeRem.toFixed(2)}rem`
    })
    document.getElementById('changelog-font-inc').addEventListener('click', () => {
        _fontSizeRem = Math.min(1.5, _fontSizeRem + 0.08)
        contentEl.style.fontSize = `${_fontSizeRem.toFixed(2)}rem`
    })

    searchEl.addEventListener('input', () => {
        if (_rawText) renderChangelogContent(_rawText, _version, searchEl.value.trim(), contentEl, itemCountEl)
    })

    async function showChangelog(version) {
        const url = `https://download.mikrotik.com/routeros/${version}/CHANGELOG`
        _version = version
        _rawText = ''
        searchEl.value = ''
        titleEl.textContent = `RouterOS ${version} — Release Notes`
        subtitleEl.textContent = ''
        mikrotikLink.href = url
        contentEl.innerHTML = '<p aria-busy="true" style="text-align:center; padding:2rem">Loading changelog…</p>'
        itemCountEl.textContent = ''

        // Find the previous version for the diff link.
        // Respects opts.includePre(): if false, skip pre-release versions so
        // e.g. "7.21.3 → 7.22" is used instead of "7.22rc4 → 7.22".
        const allVers = opts.getVersions()
        const incPre = opts.includePre()
        const idx = allVers.indexOf(version)
        let prevVer = null
        for (let i = idx + 1; i < allVers.length; i++) {
            if (incPre || !isPreRelease(allVers[i])) {
                prevVer = allVers[i]
                break
            }
        }
        if (diffLinkEl) {
            if (prevVer) {
                diffLinkEl.href = `${diffPage}?compare1=${encodeURIComponent(prevVer)}&compare2=${encodeURIComponent(version)}`
                diffLinkEl.textContent = `View Diff: ${prevVer} → ${version} ↗`
                diffLinkEl.hidden = false
            } else {
                diffLinkEl.hidden = true
            }
        }

        modal.showModal()

        try {
            const response = await fetch(url)
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const text = await response.text()
            _rawText = text

            // Extract release date for the subtitle
            const headerMatch = text.match(new RegExp(`What's new in ${_clEscapeRegex(version)} \\(([^)]+)\\)`, 'i'))
            if (headerMatch) subtitleEl.textContent = headerMatch[1]

            renderChangelogContent(text, version, '', contentEl, itemCountEl)
            if (typeof plausible !== 'undefined') plausible('Changelog View', { props: { version } })
        } catch (err) {
            console.warn('Changelog fetch failed for', version, err)
            const escaped = _clEscapeHtml(url)
            contentEl.innerHTML = `
                <p style="text-align:center; padding:2rem 1rem">
                    <span style="font-size:2rem">📋</span><br><br>
                    The changelog cannot be loaded inline (browser security restriction).<br><br>
                    <a href="${escaped}" target="_blank" rel="noopener" role="button">Open CHANGELOG on MikroTik ↗</a>
                </p>`
            itemCountEl.textContent = ''
        }
    }

    return { showChangelog }
}

// --- Share modal (<dialog>) ------------------------------------------

/**
 * Wire up a share modal. Tool pages that support shareable URLs use this.
 * Expects a <dialog> with URL input and copy button.
 *
 * @param {Object} opts
 * @param {string} opts.linkId    - ID of the "Share" link element
 * @param {string} opts.modalId   - ID of the <dialog> element
 * @param {string} opts.closeId   - ID of the close link inside the dialog
 * @param {string} opts.copyId    - ID of the "Copy to clipboard" button
 * @param {string} opts.urlId     - ID of the URL <input> in the dialog
 * @param {Function} [opts.beforeShow] - Called before showing the modal
 *                                       (e.g. to call writeQueryParams())
 */
function initShareModal(opts) {
    const modal = document.getElementById(opts.modalId)
    document.getElementById(opts.linkId).addEventListener('click', e => {
        e.preventDefault()
        if (opts.beforeShow) opts.beforeShow()
        document.getElementById(opts.urlId).value = window.location.href
        modal.showModal()
    })
    document.getElementById(opts.closeId).addEventListener('click', e => {
        e.preventDefault()
        modal.close()
    })
    modal.addEventListener('click', e => {
        if (e.target === modal) modal.close()
    })
    document.getElementById(opts.copyId).addEventListener('click', () => {
        const url = document.getElementById(opts.urlId).value
        navigator.clipboard.writeText(url).then(() => {
            const btn = document.getElementById(opts.copyId)
            btn.textContent = 'Copied!'
            setTimeout(() => { btn.textContent = 'Copy to clipboard' }, 2000)
        }).catch(() => {
            document.getElementById(opts.urlId).select()
        })
    })
}


// --- HTML escaping ---------------------------------------------------

/**
 * Escape HTML special characters for safe innerHTML insertion.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}


// --- GitHub repos dropdown -------------------------------------------
// Lazily populates a <ul> with the most recently active tikoci repos.
// Synced with tikoci.github.io shared.js.

/**
 * Fetch repos with 3+ stars and populate a dropdown list, sorted by stars.
 * Falls back gracefully to the static link if the API is unavailable.
 *
 * @param {string} listId - ID of the <ul> element to populate
 */
function initGitHubDropdown(listId) {
    const el = document.getElementById(listId)
    if (!el || el.dataset.loaded) return
    el.dataset.loaded = '1'
    const allUrl = `https://github.com/orgs/${RESTRAML.owner}/repositories`
    fetch(`https://api.github.com/search/repositories?q=org:${RESTRAML.owner}+stars:>=3&sort=stars&order=desc&per_page=30`)
        .then(r => {
            if (!r.ok) throw new Error(r.status)
            return r.json()
        })
        .then(data => {
            const repos = data.items
            if (!Array.isArray(repos)) return
            el.innerHTML = repos.map(r =>
                `<li><a href="${escapeHtml(r.html_url)}" target="_blank" rel="noopener">${escapeHtml(r.name)}</a></li>`
            ).join('') +
            `<li><a href="${allUrl}" target="_blank" rel="noopener"><strong>All repositories &rarr;</strong></a></li>`
        })
        .catch(() => { /* keep static fallback */ })
}


// --- WebMCP: expose structured tools to AI agents --------------------
// Progressive enhancement — only registers tools when the browser
// supports navigator.modelContext (Chrome 146+ with flag enabled).
// Each page calls registerWebMCPTools() to get the shared
// list_routeros_versions tool, then registers page-specific tools
// via the returned helper.
// =====================================================================

/**
 * Check whether the WebMCP imperative API is available.
 * @returns {boolean}
 */
function webMCPAvailable() {
    return typeof navigator !== 'undefined' &&
        navigator.modelContext &&
        typeof navigator.modelContext.registerTool === 'function'
}

/**
 * Register shared WebMCP tools (available on every page) and return
 * a convenience wrapper for registering page-specific tools.
 *
 * Call once per page after DOMContentLoaded, e.g.:
 *   const wmcp = registerWebMCPTools()
 *   wmcp.register({ name: 'my_tool', ... }, { signal: ctrl.signal })
 *
 * Both the shared tool and page-specific registrations accept the native
 * registerTool() options bag (for example { signal }) so pages can
 * dynamically register/unregister tools as UI state changes.
 *
 * @param {object} [sharedRegisterOptions]
 * @returns {{ register: function(toolDef: object, registerOptions?: object): void }}
 */
function registerWebMCPTools(sharedRegisterOptions = {}) {
    const noop = { register() {} }
    if (!webMCPAvailable()) return noop

    // Shared tool: list_routeros_versions
    // annotations: read-only (no state change) and untrusted content
    // (version list is derived from GitHub repo contents, which we don't
    // author — agent should treat strings as data, not instructions).
    navigator.modelContext.registerTool({
        name: 'list_routeros_versions',
        description: 'List all published RouterOS schema versions with metadata. Call this first to discover available versions before using other tools.',
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                includePreRelease: {
                    type: 'boolean',
                    description: 'Include beta and RC versions (default: false)',
                },
            },
        },
        execute: async ({ includePreRelease }) => {
            try {
                const versions = await fetchVersionList()
                const filtered = includePreRelease
                    ? versions
                    : versions.filter(v => !isPreRelease(v.name))
                return JSON.stringify(filtered.map(v => ({
                    name: v.name,
                    path: v.path,
                })))
            } catch (e) {
                return JSON.stringify({ error: e.message })
            }
        },
    }, sharedRegisterOptions)

    return {
        register(toolDef, registerOptions = {}) {
            if (webMCPAvailable()) {
                navigator.modelContext.registerTool(toolDef, registerOptions)
            }
        },
    }
}
