// =====================================================================
// restraml-shared.js — Shared utilities for all docs/*.html tool pages
//
// AGENTS: This file contains code shared across ALL tool pages.
// Page-specific logic stays inline in each HTML file.
// When adding a new docs/*.html page, include this via:
//   <script src="restraml-shared.js"></script>
// Then call initThemeSwitcher() and use the public API exported at the bottom.
//
// When modifying shared behavior, change THIS file — not inline copies.
// If you find duplicated logic inline in an HTML file, extract it here.
// =====================================================================

// --- Project constants -----------------------------------------------
const RESTRAML = Object.freeze({
    owner: 'tikoci',
    repo: 'restraml',
    pagesUrl: 'https://tikoci.github.io/restraml',
    docsIndexUrl: 'https://tikoci.github.io/restraml/docs-index.json',
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
const SYNTHETIC_VERSIONS = new Set(['nightly'])

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
 * Synthetic versions (nightly) sort before all real RouterOS versions.
 */
function compareVersions(a, b) {
    if (a === b) return 0
    if (SYNTHETIC_VERSIONS.has(a)) return -1
    if (SYNTHETIC_VERSIONS.has(b)) return 1
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
 * Returns true if the version is a pre-release (beta, rc, or nightly).
 */
function isPreRelease(name) {
    return SYNTHETIC_VERSIONS.has(name) || /(?:beta|rc)\d*$/.test(name)
}

/**
 * Rebuild a <select> element's options from a sorted version list.
 * Safari does not support `option.hidden`, so we add/remove options instead.
 * Preserves the current selection if still present.
 *
 * Supports both legacy `showAll` boolean (testing+nightly together) and
 * the new `{includeTesting, includeNightly}` object for the N5 nightly
 * toggle. When nightly info is cached via fetchNightlyJson(), the option
 * label is shown as `nightly (7.25_ab434)` instead of bare `nightly`.
 */
function rebuildSelect(sel, versions, showAll) {
    const selectedVal = sel.value
    // Remove all non-placeholder options
    while (sel.options.length > 1) sel.remove(1)
    let includeTesting
    let includeNightly
    if (showAll !== null && typeof showAll === 'object') {
        includeTesting = !!showAll.includeTesting
        includeNightly = !!showAll.includeNightly
    } else {
        includeTesting = !!showAll
        includeNightly = !!showAll
    }
    versions.forEach(name => {
        const isNightlyVersion = SYNTHETIC_VERSIONS.has(name)
        const isTesting = /(?:beta|rc)\d*$/.test(name)
        let show = true
        if (isNightlyVersion) show = includeNightly
        else if (isTesting) show = includeTesting
        if (show) {
            const label = isNightlyVersion && typeof formatVersionLabel === 'function'
                ? formatVersionLabel(name)
                : name
            sel.appendChild(new Option(label, name))
        }
    })
    // Restore selection if the value is still in the list
    if ([...sel.options].some(o => o.value === selectedVal)) {
        sel.value = selectedVal
    }
}

// --- Nightly helpers (N5) ---------------------------------------------
// Synthetic `nightly` slot: published at docs/nightly/ with provenance
// docs/nightly/nightly.json. These helpers give every page a consistent
// badge (`nightly (7.25_ab434) · 11h ago`), MIB/CHANGELOG fallbacks, and
// the shared synthetic changelog section.

const _NIGHTLY_JSON_CACHE_KEY = 'restraml_nightly_json_v1'
const _NIGHTLY_JSON_TTL = 5 * 60 * 1000 // 5 minutes
let _nightlyJsonData = null
let _nightlyJsonPromise = null

/**
 * Returns true if the name is a synthetic nightly slot.
 */
function isNightly(name) {
    return SYNTHETIC_VERSIONS.has(name)
}

/**
 * Returns true if the name is a beta/rc pre-release (excludes nightly).
 */
function isTestingPreRelease(name) {
    return /(?:beta|rc)\d*$/.test(name)
}

/**
 * Whether a version should be shown given the two toggles.
 */
function shouldShowVersion(name, includeTesting, includeNightly) {
    if (isNightly(name)) return !!includeNightly
    if (isTestingPreRelease(name)) return !!includeTesting
    return true
}

/**
 * Format a relative age string from an ISO builtAt timestamp.
 * e.g. "11h ago", "2d ago", "42m ago"
 */
function formatRelativeAge(builtAt) {
    if (!builtAt) return ''
    const ms = Date.now() - new Date(builtAt).getTime()
    if (!Number.isFinite(ms) || ms < 0) return ''
    const mins = Math.floor(ms / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    if (days < 30) return `${days}d ago`
    const months = Math.floor(days / 30)
    return `${months}mo ago`
}

/**
 * User-facing label for a version. For nightly shows the captured ab build:
 * `nightly (7.25_ab434)` when nightly info is available, otherwise bare `nightly`.
 */
function formatVersionLabel(name) {
    if (isNightly(name) && _nightlyJsonData?.nightlyVersion) {
        return `nightly (${_nightlyJsonData.nightlyVersion})`
    }
    return name
}

/**
 * Label with age suffix for table badges: `nightly (7.25_ab434) · 11h ago`.
 * Falls back to formatVersionLabel when builtAt is absent.
 */
function formatVersionLabelWithAge(name) {
    if (isNightly(name) && _nightlyJsonData?.nightlyVersion) {
        const age = formatRelativeAge(_nightlyJsonData.builtAt)
        const base = `nightly (${_nightlyJsonData.nightlyVersion})`
        return age ? `${base} · ${age}` : base
    }
    return formatVersionLabel(name)
}

/**
 * Returns the MIB download URL for a version, or null for nightly (no MIB).
 */
function getMibUrl(version) {
    if (isNightly(version)) return null
    return `https://download.mikrotik.com/routeros/${version}/mikrotik.mib`
}

/**
 * Returns the MikroTik CHANGELOG URL, or the nightly Box share for the synthetic slot.
 */
function getChangelogUrl(version) {
    if (isNightly(version)) return 'https://mt.lv/nightly-build'
    return `https://download.mikrotik.com/routeros/${version}/CHANGELOG`
}

/**
 * Fetch and cache docs/nightly/nightly.json (provenance for the synthetic slot).
 * Returns the parsed nightly.json object or null if not published / 404.
 * Cached in memory and localStorage for 5 minutes; falls back to stale cache.
 */
function fetchNightlyJson() {
    if (_nightlyJsonPromise) return _nightlyJsonPromise
    const p = _fetchNightlyJsonInner()
    _nightlyJsonPromise = p
    p.finally(() => { if (_nightlyJsonPromise === p) _nightlyJsonPromise = null }).catch(() => {})
    return p
}

function _fetchNightlyJsonInner() {
    try {
        const raw = localStorage.getItem(_NIGHTLY_JSON_CACHE_KEY)
        if (raw) {
            const cached = JSON.parse(raw)
            if (cached?.ts && Date.now() - cached.ts < _NIGHTLY_JSON_TTL && cached.data) {
                _nightlyJsonData = cached.data
                return Promise.resolve(cached.data)
            }
        }
    } catch { /* ignore corrupted cache */ }

    const url = `${RESTRAML.pagesUrl}/nightly/nightly.json`
    return fetch(url)
        .then(r => {
            if (!r.ok) {
                if (r.status === 404) return null
                const stale = _readStaleNightlyCache()
                if (stale) return stale
                throw new Error(`nightly.json ${r.status}`)
            }
            return r.json()
        })
        .then(data => {
            if (!data || typeof data.nightlyVersion !== 'string') return null
            _nightlyJsonData = data
            try {
                localStorage.setItem(_NIGHTLY_JSON_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }))
            } catch { /* storage full */ }
            return data
        })
        .catch(err => {
            const stale = _readStaleNightlyCache()
            if (stale) {
                _nightlyJsonData = stale
                return stale
            }
            // 404 before first publish is expected — not an error.
            if (err && String(err.message || err).includes('404')) return null
            throw err
        })
}

function _readStaleNightlyCache() {
    try {
        const raw = localStorage.getItem(_NIGHTLY_JSON_CACHE_KEY)
        if (raw) {
            const cached = JSON.parse(raw)
            if (cached?.data && typeof cached.data.nightlyVersion === 'string') {
                return cached.data
            }
        }
    } catch { /* ignore */ }
    return null
}

/**
 * Synchronous accessor for the last fetched nightly.json (or null).
 * Call after fetchNightlyJson() has resolved.
 */
function getCachedNightlyJson() {
    return _nightlyJsonData
}

/**
 * Build a synthetic changelog section for the nightly slot from nightly.json.
 * Shape matches parseChangelogSections() output so the existing renderers work.
 */
function createNightlySyntheticSections(nightlyData) {
    if (!nightlyData || typeof nightlyData.nightlyVersion !== 'string') return []
    const dateStr = nightlyData.builtAt
        ? new Date(nightlyData.builtAt).toLocaleDateString('en-CA')
        : new Date().toLocaleDateString('en-CA')
    const heading = `What's new in nightly (${nightlyData.nightlyVersion}) (${dateStr}):`
    const baseVer = nightlyData.baseVersion || 'stable'
    const entries = []
    const x86Count = nightlyData.packages?.x86?.count
    const arm64Count = nightlyData.packages?.arm64?.count
    const buildWindow = nightlyData.buildWindow
    const absent = nightlyData.absentRoots

    entries.push({
        raw: `*) nightly - Nightly build ${nightlyData.nightlyVersion} from mt.lv/nightly-build (built ${nightlyData.builtAt || ''}, base ${baseVer})`,
        important: false,
        secure: false,
        subsystem: 'nightly',
        text: `Nightly build ${nightlyData.nightlyVersion} from mt.lv/nightly-build (built ${nightlyData.builtAt || ''}, base ${baseVer}) — single overwritten slot docs/nightly/`,
    })
    if (buildWindow?.earliest && buildWindow?.latest) {
        entries.push({
            raw: `*) buildWindow - Upload window ${buildWindow.earliest} → ${buildWindow.latest}`,
            important: false,
            secure: false,
            subsystem: 'buildWindow',
            text: `Upload window ${buildWindow.earliest} → ${buildWindow.latest}`,
        })
    }
    if (Number.isFinite(x86Count) || Number.isFinite(arm64Count)) {
        const parts = []
        if (Number.isFinite(x86Count)) parts.push(`x86: ${x86Count} NPKs${nightlyData.packages?.x86?.names ? ` (${nightlyData.packages.x86.names.join(', ')})` : ''}`)
        if (Number.isFinite(arm64Count)) parts.push(`arm64: ${arm64Count} NPKs${nightlyData.packages?.arm64?.names ? ` (${nightlyData.packages.arm64.names.join(', ')})` : ''}`)
        entries.push({
            raw: `*) packages - ${parts.join('; ')}`,
            important: false,
            secure: false,
            subsystem: 'packages',
            text: parts.join('; '),
        })
    }
    if (Array.isArray(absent) && absent.length > 0) {
        entries.push({
            raw: `*) note - extra/ is partial: absent roots ${absent.join(', ')} have no nightly NPKs`,
            important: false,
            secure: false,
            subsystem: 'note',
            text: `extra/ is partial — absent roots ${absent.join(', ')} have no nightly NPKs on Box, so diff vs release extra shows them as "removed"`,
        })
    }
    const boxToken = nightlyData.source?.token
    const boxUrl = boxToken ? ` → https://box.mikrotik.com/d/${boxToken}/` : ''
    entries.push({
        raw: `*) source - Box share https://mt.lv/nightly-build${boxUrl}`,
        important: false,
        secure: false,
        subsystem: 'source',
        text: `Source: mt.lv/nightly-build (Box) — see nightly.json for full provenance`,
    })

    return [{
        version: 'nightly',
        date: dateStr,
        heading,
        entries,
        sourceUrl: 'https://mt.lv/nightly-build',
    }]
}

/**
 * Render an array of changelog sections (as returned by parseChangelogSections
 * or createNightlySyntheticSections) into contentEl.
 */
function renderChangelogSections(sections, query, contentEl, itemCountEl) {
    const q = query ? query.toLowerCase() : ''
    let html = ''
    let totalEntries = 0
    let visibleEntries = 0
    let visibleSections = 0

    for (const section of sections) {
        totalEntries += section.entries.length
        const headerMatches = q && (
            section.heading.toLowerCase().includes(q)
            || section.version.toLowerCase().includes(q)
            || section.date.toLowerCase().includes(q)
        )
        const entries = q
            ? (headerMatches
                ? section.entries
                : section.entries.filter(entry =>
                    entry.raw.toLowerCase().includes(q)
                    || entry.subsystem.toLowerCase().includes(q)
                    || entry.text.toLowerCase().includes(q)
                ))
            : section.entries

        if (q && entries.length === 0) continue
        visibleSections++
        const sectionLink = section.sourceUrl
            ? `<a href="${escapeHtml(section.sourceUrl)}" target="_blank" rel="noopener" class="secondary">CHANGELOG ↗</a>`
            : ''
        const headerCls = sectionLink ? 'cl-section-header cl-section-header-link' : 'cl-section-header'
        if (sectionLink) {
            html += `<span class="${headerCls}"><span>${_clHighlight(section.heading, query)}</span>${sectionLink}</span>`
        } else {
            html += `<span class="${headerCls}">${_clHighlight(section.heading, query)}</span>`
        }
        for (const entry of entries) {
            visibleEntries++
            html += renderChangelogEntryHtml(entry, query)
        }
    }

    if (!sections.length) {
        contentEl.innerHTML = '<p style="opacity:0.65; padding:2rem; text-align:center"><em>No release note sections found.</em></p>'
        if (itemCountEl) itemCountEl.textContent = ''
        return
    }
    if (!html.trim()) {
        contentEl.innerHTML = '<p style="opacity:0.65; padding:2rem 0; text-align:center"><em>No matching changelog entries found.</em></p>'
    } else {
        contentEl.innerHTML = html
    }
    if (itemCountEl) {
        if (q) {
            itemCountEl.textContent = `${visibleEntries} of ${totalEntries} entries across ${visibleSections} of ${sections.length} releases match "${query}"`
        } else {
            itemCountEl.textContent = `${totalEntries} entries across ${sections.length} release${sections.length === 1 ? '' : 's'}`
        }
    }
}

/**
 * Fetch changelog sections for a single version. For nightly returns the
 * synthetic section without hitting download.mikrotik.com (which 404s).
 */
async function fetchChangelogSectionsForVersion(version) {
    if (isNightly(version)) {
        const nightlyData = (_nightlyJsonData && !_nightlyJsonData._partial) ? _nightlyJsonData : await fetchNightlyJson()
        if (nightlyData) return createNightlySyntheticSections(nightlyData)
        // Fallback synthetic when nightly.json hasn't been fetched yet
        return [{
            version: 'nightly',
            date: new Date().toLocaleDateString('en-CA'),
            heading: `What's new in nightly (synthetic):`,
            entries: [{
                raw: '*) nightly - Nightly build from mt.lv/nightly-build (see nightly.json)',
                important: false,
                secure: false,
                subsystem: 'nightly',
                text: 'Nightly build from mt.lv/nightly-build — see docs/nightly/nightly.json for provenance',
            }],
            sourceUrl: 'https://mt.lv/nightly-build',
        }]
    }
    const url = `https://download.mikrotik.com/routeros/${version}/CHANGELOG`
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const text = await resp.text()
    const sections = parseChangelogSections(text)
    // Annotate sourceUrl for rendering
    for (const s of sections) s.sourceUrl = url
    return sections
}

/**
 * Filter candidate versions to the changelog range (older, newer].
 * Excludes synthetic versions (nightly) — they have no CHANGELOG on
 * download.mikrotik.com and would otherwise make compareVersions(v, 'nightly')
 * true for every version, pulling the whole history.
 */
function getChangelogVersionsInRange(range, allVersions, includeTesting) {
    const candidateVersions = includeTesting
        ? allVersions.filter(v => !isNightly(v))
        : allVersions.filter(v => !isNightly(v) && !isTestingPreRelease(v))
    if (range.older === range.newer) {
        return candidateVersions.filter(v => v === range.newer)
    }
    return candidateVersions.filter(version =>
        compareVersions(version, range.newer) >= 0
        && compareVersions(version, range.older) < 0
    )
}

// --- Published docs inventory: fetch version directory listing --------
// docs/docs-index.json is generated from the repository's docs/ tree and
// published via GitHub Pages. All docs/*.html pages share this cache via
// the same origin. If the fresh fetch fails, we fall back to stale cache.

const _VER_CACHE_KEY = 'restraml_docs_index_v1'
const _VER_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/** In-memory promise so concurrent calls within the same page share one request. */
let _verListPromise = null

/**
 * Fetch the list of built versions from the published docs index.
 * Returns a promise resolving to an array of directory objects,
 * sorted newest-first by version. Each has { name, path, type, files, dirs }.
 *
 * Results are cached in localStorage for 5 minutes to reduce fetches
 * across page navigations (all docs pages share the same GH Pages origin).
 * On fetch failure, falls back to stale cache regardless of TTL.
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
            if (cached?.ts && Date.now() - cached.ts < _VER_CACHE_TTL && Array.isArray(cached.data)) {
                return Promise.resolve(cached.data)
            }
        }
    } catch { /* ignore corrupted cache */ }

    return fetch(RESTRAML.docsIndexUrl)
        .then(r => {
            if (!r.ok) {
                const stale = _readStaleVersionCache()
                if (stale) return stale
                throw new Error(`Published docs index returned ${r.status} ${r.statusText}`)
            }
            return r.json()
        })
        .then(data => {
            if (!data || !Array.isArray(data.versions)) {
                throw new Error('Unexpected docs index response')
            }
            const versions = data.versions
                .filter(f => f.type === 'dir')
                .sort((a, b) => compareVersions(a.name, b.name))
            // Persist to localStorage
            try {
                localStorage.setItem(_VER_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: versions }))
            } catch { /* storage full or unavailable */ }
            // Opportunistically cache nightly info from docs-index if present
            if (data.nightly && typeof data.nightly.nightlyVersion === 'string') {
                // Seed _nightlyJsonData with the minimal nightly fields so badge
                // can render even before nightly.json is fetched.
                // Marked _partial so consumers that need full provenance still fetch nightly.json.
                if (!_nightlyJsonData) {
                    _nightlyJsonData = {
                        nightlyVersion: data.nightly.nightlyVersion,
                        builtAt: data.nightly.builtAt,
                        _partial: true,
                    }
                }
            }
            return versions
        })
        .catch(err => {
            const stale = _readStaleVersionCache()
            if (stale) return stale
            throw err
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

    const setInitialIcon = () => {
        el.innerHTML = _THEME_ICONS.osDefault
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setInitialIcon)
    } else {
        setInitialIcon()
    }

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
        // For nightly synthetic sections we re-render via sections
        if (!_rawText && isNightly(_version) && _nightlyJsonData) {
            const sections = createNightlySyntheticSections(_nightlyJsonData)
            renderChangelogSections(sections, searchEl.value.trim(), contentEl, itemCountEl)
        }
    })

    async function showChangelog(version) {
        const isNightlyVersion = isNightly(version)
        const url = getChangelogUrl(version)
        _version = version
        _rawText = ''
        searchEl.value = ''
        titleEl.textContent = isNightlyVersion && _nightlyJsonData?.nightlyVersion
            ? `RouterOS nightly (${_nightlyJsonData.nightlyVersion}) — Release Notes`
            : `RouterOS ${version} — Release Notes`
        subtitleEl.textContent = isNightlyVersion && _nightlyJsonData?.builtAt
            ? new Date(_nightlyJsonData.builtAt).toLocaleString()
            : ''
        mikrotikLink.href = url
        mikrotikLink.textContent = isNightlyVersion ? 'mt.lv/nightly-build ↗' : 'CHANGELOG ↗'
        contentEl.innerHTML = '<p aria-busy="true" style="text-align:center; padding:2rem">Loading changelog…</p>'
        itemCountEl.textContent = ''

        // Find the previous version for the diff link.
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

        // Nightly: synthetic section from nightly.json (no 404)
        if (isNightlyVersion) {
            try {
                const nightlyData = (_nightlyJsonData && !_nightlyJsonData._partial) ? _nightlyJsonData : await fetchNightlyJson()
                if (nightlyData) {
                    // Update title/subtitle with fresh nightly data
                    titleEl.textContent = `RouterOS nightly (${nightlyData.nightlyVersion}) — Release Notes`
                    subtitleEl.textContent = nightlyData.builtAt ? new Date(nightlyData.builtAt).toLocaleString() : ''
                    mikrotikLink.href = 'https://mt.lv/nightly-build'
                    const sections = createNightlySyntheticSections(nightlyData)
                    renderChangelogSections(sections, '', contentEl, itemCountEl)
                    if (typeof plausible !== 'undefined') plausible('Changelog View', { props: { version } })
                    return
                }
                // No nightly data yet — show friendly placeholder
                contentEl.innerHTML = `
                    <p style="text-align:center; padding:2rem 1rem">
                        <span style="font-size:2rem">🌙</span><br><br>
                        Nightly build from <a href="https://mt.lv/nightly-build" target="_blank" rel="noopener">mt.lv/nightly-build</a><br>
                        No nightly provenance found — docs/nightly/nightly.json not yet published.<br><br>
                        <a href="https://mt.lv/nightly-build" target="_blank" rel="noopener" role="button">Open nightly share ↗</a>
                    </p>`
                itemCountEl.textContent = ''
                return
            } catch (err) {
                console.warn('Nightly synthetic changelog failed', err)
                contentEl.innerHTML = `
                    <p style="text-align:center; padding:2rem 1rem">
                        <span style="font-size:2rem">🌙</span><br><br>
                        Nightly build from <a href="https://mt.lv/nightly-build" target="_blank" rel="noopener">mt.lv/nightly-build</a><br><br>
                        <a href="https://mt.lv/nightly-build" target="_blank" rel="noopener" role="button">Open nightly share ↗</a>
                    </p>`
                itemCountEl.textContent = ''
                return
            }
        }

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


// --- Public API -------------------------------------------------------
// All functions called by HTML pages that include this file via
// <script src="restraml-shared.js"> are listed here. Explicit window
// assignment makes the public API visible to static analysis tools
// (Biome, CodeQL) that analyze this file without seeing HTML consumers.
Object.assign(window, {
    RESTRAML,
    parseVersion,
    compareVersions,
    isPreRelease,
    isNightly,
    isTestingPreRelease,
    shouldShowVersion,
    rebuildSelect,
    fetchVersionList,
    fetchNightlyJson,
    getCachedNightlyJson,
    formatVersionLabel,
    formatVersionLabelWithAge,
    formatRelativeAge,
    getMibUrl,
    getChangelogUrl,
    createNightlySyntheticSections,
    renderChangelogSections,
    fetchChangelogSectionsForVersion,
    getChangelogVersionsInRange,
    initThemeSwitcher,
    renderChangelogEntryHtml,
    parseChangelogSections,
    renderChangelogContent,
    initChangelogModal,
    initShareModal,
    escapeHtml,
    webMCPAvailable,
    registerWebMCPTools,
})
