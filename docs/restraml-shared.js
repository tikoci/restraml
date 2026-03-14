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

/**
 * Fetch the list of built versions from the GitHub API.
 * Returns a promise resolving to an array of GitHub content objects,
 * sorted newest-first by version. Each has { name, path, type, ... }.
 */
function fetchVersionList() {
    return fetch(RESTRAML.apiContentsUrl)
        .then(r => {
            if (!r.ok) throw new Error(`GitHub API returned ${r.status} ${r.statusText}`)
            return r.json()
        })
        .then(data => {
            if (!Array.isArray(data)) throw new Error('Unexpected GitHub API response')
            return data
                .filter(f => f.type === 'dir' && f.name !== 'extra')
                .sort((a, b) => compareVersions(a.name, b.name))
        })
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
