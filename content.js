/**
 * Anilist Hover Comments
 *
 * This script enhances Anilist anime/manga pages by displaying user comments via
 * a hover interface
 *
 * Features:
 * - Shows a comment icon next to user entries with comments
 * - Displays comments in a tooltip on hover or click
 * - Implements positive and negative caching to minimize API requests
 * - Handles SPA (Single Page Application) navigation
 * - Silent error handling without console pollution
 *
 * @author ExAstra
 * @see https://github.com/rikymarche-ctrl/anilist-extension
 */

/**
 * Configuration constants for application behavior
 */
const ANILIST_API_RATE_LIMIT = 90; // Official Anilist limit

const CONFIG = {
    CACHE_MAX_AGE: 2 * 24 * 60 * 60 * 1000, // 48 hours
    NEGATIVE_CACHE_AGE: 60 * 60 * 1000, // 1 hour
    MAX_REQUESTS_PER_MINUTE: ANILIST_API_RATE_LIMIT / 2,
    RATE_LIMIT_DURATION: 60000,
    BATCH_DELAY: 200,
    TOOLTIP_SHOW_DELAY: 50,
    TOOLTIP_HIDE_DELAY: 1000,
    AUTO_HIDE_CHECK_INTERVAL: 500,
    CACHE_SAVE_INTERVAL: 300000,
    MAIN_LOOP_INTERVAL: 250,
    DEBUG_MODE: false
};

/**
 * Inline SVG Icons
 */
const ICON_COMMENT_SVG = `<svg class="svg-inline--fa" style="width: 1em; height: 1em; vertical-align: -0.125em;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M512 240c0 114.9-114.6 208-256 208c-37.1 0-72.3-6.4-104.1-17.9c-11.9 8.7-31.3 20.6-54.3 30.6C73.6 471.1 44.7 480 16 480c-6.5 0-12.3-3.9-14.8-9.9c-2.5-6-1.1-12.8 3.4-17.4l4.1-4.1c10.1-10.1 16.6-23.3 18.2-38.1C11.2 367.1 0 306.7 0 240C0 125.1 114.6 32 256 32s256 93.1 256 208z"/></svg>`;

/**
 * CSS selectors used throughout the application
 */
const SELECTORS = {
    FOLLOWING_SECTION: 'div.following, div[class="following"], div[class^="following"]',
    USER_LINKS: 'a[href^="/user/"]',
    SCORE: 'div[class*="score-"]',
    COMMENT_ICON: '.anilist-comment-icon',
    COMMENT_ICON_COLUMN: '.comment-icon-column',
    TOOLTIP: '#anilist-tooltip',
    REFRESH_ALL_BTN: '.anilist-refresh-all-btn'
};

/**
 * Silent logger that only shows output in debug mode
 */
class Logger {
    static log(message, ...args) {
        if (CONFIG.DEBUG_MODE) {
            console.log(`[AnilistExt] ${message}`, ...args);
        }
    }
    static warn(message, ...args) {
        if (CONFIG.DEBUG_MODE) {
            console.warn(`[AnilistExt] ${message}`, ...args);
        }
    }
    static error(message, ...args) {
        if (CONFIG.DEBUG_MODE) {
            console.error(`[AnilistExt] ${message}`, ...args);
        }
    }
}

/**
 * Main application class
 */
class AnilistHoverComments {
    constructor() {
        this.lastUrl = location.href;
        this.lastMediaId = null;
        this.mainLoopInterval = null;
        this.processedLinks = new Set(); // Tracks already processed links
        // RIMOSSO: this.refreshAllButtonInjected = false;

        this.cacheManager = new CacheManager();
        this.apiManager = new ApiManager(this.cacheManager);
        this.tooltipManager = TooltipManager.getInstance(this.apiManager);
        this.apiManager.setTooltipManager(this.tooltipManager); // Link the tooltip manager to the api manager

        Logger.log("Anilist Hover Comments: Initialized!");
    }

    /**
     * Main initialization
     */
    async init() {
        await this.cacheManager.load();
        this.startMainLoop();
    }

    /**
     * Starts the main loop
     */
    startMainLoop() {
        if (this.mainLoopInterval) {
            clearInterval(this.mainLoopInterval);
        }

        this.mainLoopInterval = setInterval(
            () => this.mainLoop(),
            CONFIG.MAIN_LOOP_INTERVAL
        );
    }

    /**
     * The single main loop that replaces all observers.
     */
    mainLoop() {
        const currentUrl = location.href;
        const media = this.extractMediaFromUrl();

        // 1. Check for URL changes
        if (currentUrl !== this.lastUrl) {
            Logger.log("URL change detected, resetting state.");
            this.lastUrl = currentUrl;
            this.lastMediaId = null;
            this.processedLinks.clear();
            this.tooltipManager.hide(true); // Force-hide the tooltip
        }

        // 2. Check for media page
        if (!media) {
            this.lastMediaId = null;
            return; // Not on a media page
        }

        // 3. Check for new Media ID
        if (media.id !== this.lastMediaId) {
            Logger.log(`New media page detected: ${media.id}`);
            this.lastMediaId = media.id;
            this.processedLinks.clear();
        }

        // 4. Process user links
        this.processUserLinks(media.id);

        // 5. Inject Refresh All button if needed
        if (this.lastMediaId) {
            this.injectRefreshAllButton();
        }
    }

    /**
     * Injects the "Refresh All" button next to the "Following" H2
     */
    injectRefreshAllButton() {
        const followingSection = this.findFollowingSection();
        if (!followingSection) return; // Section not ready

        const followingH2 = followingSection.previousElementSibling;

        if (followingH2 && followingH2.tagName === 'H2' && !followingH2.querySelector(SELECTORS.REFRESH_ALL_BTN)) {
            Logger.log("Injecting Refresh All button");

            followingH2.style.position = 'relative';

            const refreshButton = document.createElement('span');
            refreshButton.className = 'anilist-refresh-all-btn comment-icon-column';
            refreshButton.innerHTML = '<i class="fas fa-sync-alt"></i>';
            refreshButton.title = 'Refresh all comments for this media';

            refreshButton.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.handleRefreshAll();
            });

            followingH2.appendChild(refreshButton);
        }
    }

    /**
     * Handles the click event for "Refresh All"
     */
    handleRefreshAll() {
        Logger.log("Handling Refresh All");
        const media = this.extractMediaFromUrl();
        if (!media) return;

        const followingSection = this.findFollowingSection();
        if (!followingSection) return;

        const userLinks = followingSection.querySelectorAll(SELECTORS.USER_LINKS);
        if (!userLinks.length) return;

        // 1. Clear processed state
        this.processedLinks.clear();

        // 2. Delete cache for all visible users
        for (const link of userLinks) {
            const username = this.extractUsername(link);
            if (username) {
                const cacheKey = `${username}-${media.id}`;
                this.cacheManager.delete(cacheKey);

                // 3. Remove existing icons immediately for visual feedback
                const icon = link.querySelector(SELECTORS.COMMENT_ICON_COLUMN);
                if (icon) {
                    icon.remove();
                }
            }
        }

        // 4. Provide visual feedback on the button
        const btn = document.querySelector(SELECTORS.REFRESH_ALL_BTN);
        if (btn) {
            // MODIFICA: Usa l'icona 'spinner' di Font Awesome
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            setTimeout(() => {
                // MODIFICA: Reimposta l'icona 'sync-alt'
                btn.innerHTML = '<i class="fas fa-sync-alt"></i>';
            }, 2000);
        }

        // 5. The mainLoop will automatically pick up the changes
        // on its next 250ms tick, find no cache, and re-queue everything.
        Logger.log(`Cleared cache for ${userLinks.length} users. Main loop will re-fetch.`);
    }


    /**
     * Process all user links in the following section
     */
    processUserLinks(mediaId) {
        const followingSection = this.findFollowingSection();
        if (!followingSection) {
            return; // Section not yet loaded
        }

        const userLinks = followingSection.querySelectorAll(SELECTORS.USER_LINKS);
        if (userLinks.length === 0) {
            return; // Links not yet loaded
        }

        for (const link of userLinks) {
            const username = this.extractUsername(link);
            if (username) {
                const linkKey = `${username}-${mediaId}`;
                // Only process if new or icon disappeared
                const hasIcon = link.querySelector(SELECTORS.COMMENT_ICON_COLUMN);

                if (!this.processedLinks.has(linkKey) || !hasIcon) {
                    this.processUser(link, username, mediaId);
                    if (!hasIcon) {
                        this.processedLinks.delete(linkKey); // Force re-processing if icon was removed
                    }
                }
            }
        }
    }

    /**
     * Process a single user entry with negative caching
     */
    async processUser(entry, username, mediaId) {
        // Prevents double-adding
        if (entry.querySelector(SELECTORS.COMMENT_ICON_COLUMN)) return;

        const cacheKey = `${username}-${mediaId}`;
        const cachedComment = this.cacheManager.get(cacheKey);

        const shouldFetch = (cache) => {
            if (!cache) {
                return true; // No cache, must fetch
            }
            if (cache.hasContent() && !cache.isValid()) {
                return true; // Positive cache is expired, must fetch
            }

            return !cache.hasContent() && !cache.isNegativeCacheValid();
        };

        if (cachedComment && cachedComment.hasContent()) {
            // Case 1: Valid (or expired) POSITIVE cache.
            // Show the icon immediately. The tooltip's
            // `loadComment` function will handle refreshing if it's expired.
            this.addIcon(entry, username, mediaId);
            this.processedLinks.add(cacheKey);
        }
        else if (shouldFetch(cachedComment)) {
            // Case 2: No cache OR Expired negative cache OR Expired positive cache.
            // Fetch from API.
            this.apiManager.queueRequest(entry, username, mediaId, (hasContent) => {
                if (hasContent && !entry.querySelector(SELECTORS.COMMENT_ICON_COLUMN)) {
                    this.addIcon(entry, username, mediaId);
                    this.processedLinks.add(cacheKey);
                } else if (!hasContent) {
                    // This ensures we mark it as processed even if the new fetch is empty
                    this.processedLinks.add(cacheKey);
                }
            });
        }
        else {
            // Case 3: Valid NEGATIVE cache.
            // Do nothing.
            this.processedLinks.add(cacheKey);
        }
    }

    /**
     * Add a comment icon to user entry
     */
    addIcon(entry, username, mediaId) {
        // Double-check
        if (entry.querySelector(SELECTORS.COMMENT_ICON_COLUMN)) return;

        const iconContainer = this.createIconContainer(username, mediaId);
        const icon = this.createIcon();
        iconContainer.appendChild(icon);

        // Insert before the 'score' element for robust positioning
        const scoreEl = entry.querySelector(SELECTORS.SCORE);
        if (scoreEl) {
            scoreEl.parentNode.insertBefore(iconContainer, scoreEl);
        } else {
            entry.appendChild(iconContainer); // Fallback
        }

        this.setupIconEvents(iconContainer, username, mediaId);
        Logger.log(`Icon added for ${username}`);
    }

    createIconContainer(username, mediaId) {
        const container = document.createElement('div');
        container.className = 'comment-icon-column';
        container.dataset.username = username;
        container.dataset.mediaId = mediaId;
        return container;
    }

    createIcon() {
        const icon = document.createElement('span');
        icon.className = 'anilist-comment-icon';
        icon.innerHTML = ICON_COMMENT_SVG;
        return icon;
    }

    setupIconEvents(iconContainer, username, mediaId) {
        const parentEntry = iconContainer.closest('a');

        // Row hover effects
        if (parentEntry) {
            const rowEnterHandler = () => {
                const icon = iconContainer.querySelector(SELECTORS.COMMENT_ICON);
                if (icon) icon.classList.add('row-hover');
            };
            const rowLeaveHandler = () => {
                const icon = iconContainer.querySelector(SELECTORS.COMMENT_ICON);
                if (icon) icon.classList.remove('row-hover');
            };
            parentEntry.addEventListener("mouseenter", rowEnterHandler);
            parentEntry.addEventListener("mouseleave", rowLeaveHandler);
        }

        // Icon-specific events
        const iconEnterHandler = (e) => {
            e.stopPropagation();
            this.tooltipManager.handleIconEnter(iconContainer, username, mediaId);
        };
        const iconLeaveHandler = (e) => {
            e.stopPropagation();
            this.tooltipManager.handleIconLeave();
        };
        const iconClickHandler = (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.tooltipManager.handleIconClick(iconContainer, username, mediaId);
        };

        iconContainer.addEventListener("mouseenter", iconEnterHandler);
        iconContainer.addEventListener("mouseleave", iconLeaveHandler);
        iconContainer.addEventListener("click", iconClickHandler);
    }

    /**
     * Find the following section in the DOM
     */
    findFollowingSection() {
        const section = document.querySelector(SELECTORS.FOLLOWING_SECTION);
        if (section) return section;

        // Fallback: find by title
        const h2Elements = document.querySelectorAll('h2');
        for (const h2 of h2Elements) {
            if (h2.textContent.includes('Following')) {
                return h2.nextElementSibling;
            }
        }
        return null;
    }

    extractUsername(link) {
        const href = link.getAttribute('href');
        if (!href) return null;
        return href.replace('/user/', '').replace(/\/$/, '');
    }

    extractMediaFromUrl() {
        const match = window.location.pathname.match(/\/(anime|manga)\/(\d+)/);
        if (match && match[2]) {
            return {
                id: parseInt(match[2]),
                type: match[1].toUpperCase()
            };
        }
        return null;
    }

    destroy() {
        if (this.mainLoopInterval) {
            clearInterval(this.mainLoopInterval);
        }
        this.cacheManager.destroy();
        this.tooltipManager.destroy();
        Logger.log("Anilist Hover Comments: Destroyed!");
    }
}

/**
 * Enhanced cache manager with negative caching
 */
class CacheManager {
    constructor() {
        this.cache = {};
        this.saveInterval = null;
    }

    async load() {
        try {
            const cached = localStorage.getItem('anilist_comment_cache');
            if (cached) {
                this.cache = JSON.parse(cached) || {};
            }
        } catch (error) {
            Logger.warn('Cache loading failed:', error.message);
            this.cache = {};
        }
        this.startPeriodicSave();
    }

    get(key) {
        const data = this.cache[key];
        if (!data) return null;
        return new CachedComment(data.content, data.timestamp);
    }

    set(key, content) {
        this.cache[key] = {
            content: content || '',
            timestamp: Date.now()
        };
    }

    /**
     * NEW: Method to delete a specific cache entry
     */
    delete(key) {
        if (this.cache[key]) {
            delete this.cache[key];
            Logger.log(`Cache entry deleted: ${key}`);
        }
    }

    save() {
        try {
            localStorage.setItem('anilist_comment_cache', JSON.stringify(this.cache));
            return true;
        } catch (error) {
            Logger.warn('Cache saving failed:', error.message);
            return false;
        }
    }

    startPeriodicSave() {
        if (this.saveInterval) clearInterval(this.saveInterval);
        this.saveInterval = setInterval(() => {
            this.save();
        }, CONFIG.CACHE_SAVE_INTERVAL);
    }

    destroy() {
        if (this.saveInterval) clearInterval(this.saveInterval);
        this.save();
    }
}

/**
 * Cached comment with negative caching support
 */
class CachedComment {
    constructor(content, timestamp) {
        this.content = content;
        this.timestamp = timestamp;
    }

    isValid() {
        return (Date.now() - this.timestamp) < CONFIG.CACHE_MAX_AGE;
    }

    isNegativeCacheValid() {
        if (this.hasContent()) return false;
        return (Date.now() - this.timestamp) < CONFIG.NEGATIVE_CACHE_AGE;
    }

    hasContent() {
        return this.content && this.content.trim() !== '';
    }

    getAge() {
        return Date.now() - this.timestamp;
    }

    getFormattedAge() {
        const now = new Date();
        const diffMs = now - this.timestamp;
        const diffSec = Math.floor(diffMs / 1000);
        const diffMin = Math.floor(diffSec / 60);
        const diffHour = Math.floor(diffMin / 60);

        if (diffSec < 30) return "just now";
        if (diffMin < 1) return `${diffSec} sec ago`;
        if (diffHour < 1) return `${diffMin} min ago`;
        if (diffHour < 24) return `${diffHour} hours ago`;

        return new Date(this.timestamp).toLocaleDateString();
    }
}

/**
 * Enhanced API manager with silent error handling
 */
class ApiManager {
    constructor(cacheManager) {
        this.cacheManager = cacheManager;
        this.tooltipManager = null; // Will be set by 'setTooltipManager'
        this.queue = [];
        this.pendingRequests = new Set();
        this.isProcessing = false;
        this.requestCount = 0;
        this.lastReset = Date.now();
        this.isRateLimited = false;
    }

    setTooltipManager(tooltipManager) {
        this.tooltipManager = tooltipManager;
    }

    queueRequest(entry, username, mediaId, callback) {
        const requestKey = `${username}-${mediaId}`;
        if (this.pendingRequests.has(requestKey)) return;

        this.pendingRequests.add(requestKey);
        this.queue.push({ entry, username, mediaId, callback, requestKey });

        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    async processQueue() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            return;
        }
        this.isProcessing = true;

        while (this.queue.length > 0) {
            if (!this.checkRateLimit()) {
                setTimeout(() => this.processQueue(), CONFIG.RATE_LIMIT_DURATION);
                return;
            }

            const request = this.queue.shift();
            // Add check if request is null (can happen in race conditions)
            if (request) {
                await this.processRequest(request);
            }

            if (this.queue.length > 0) {
                await this.delay(CONFIG.BATCH_DELAY);
            }
        }
        this.isProcessing = false;
    }

    async processRequest(request) {
        // We destructure only what's needed in the try block.
        const { username, mediaId, callback } = request;
        try {
            const comment = await this.fetchUserComment(username, mediaId);

            const cacheKey = `${username}-${mediaId}`;
            this.cacheManager.set(cacheKey, comment);

            if (callback) {
                callback(comment && comment.trim() !== '');
            }
        } catch (error) {
            Logger.warn(`API request failed for ${request.username}: ${error.message}`);
            // Set negative cache
            this.cacheManager.set(`${request.username}-${request.mediaId}`, '');
            if (request.callback) {
                request.callback(false);
            }
        } finally {
            // Use request.requestKey directly to fix 'unused variable' warning
            this.pendingRequests.delete(request.requestKey);
        }
    }

    /**
     * Public function for manual refresh from the tooltip
     */
    async refreshComment(username, mediaId) {
        if (!this.checkRateLimit()) {
            Logger.warn("Rate limit hit, refresh failed.");
            return 'rate_limited';
        }

        try {
            const comment = await this.fetchUserComment(username, mediaId);
            const cacheKey = `${username}-${mediaId}`;
            this.cacheManager.set(cacheKey, comment);

            // Update tooltip if it's visible
            if (this.tooltipManager) {
                const cachedComment = this.cacheManager.get(cacheKey);
                this.tooltipManager.updateIfVisible(username, mediaId, cachedComment);
            }
            return 'success';
        } catch (error) {
            Logger.error("Manual refresh failed:", error.message);
            return 'error';
        }
    }

    checkRateLimit() {
        const now = Date.now();
        if (now - this.lastReset > CONFIG.RATE_LIMIT_DURATION) {
            this.requestCount = 0;
            this.lastReset = now;
            this.isRateLimited = false;
        }
        if (this.requestCount >= CONFIG.MAX_REQUESTS_PER_MINUTE) {
            this.isRateLimited = true;
            return false;
        }
        this.requestCount++;
        return true;
    }

    async fetchUserComment(username, mediaId) {
        const query = `
            query ($userName: String, $mediaId: Int) {
                MediaList(userName: $userName, mediaId: $mediaId) {
                    notes
                }
            }
        `;
        const variables = { userName: username, mediaId: parseInt(mediaId) };
        const response = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ query, variables })
        });
        if (!response.ok) {
            if (response.status === 429) this.isRateLimited = true;
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (data.errors) throw new Error('GraphQL errors');
        return data.data?.MediaList?.notes || "";
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    destroy() {
        this.queue = [];
        this.pendingRequests.clear();
    }
}

/**
 * Tooltip Manager (Refactored)
 */
class TooltipManager {
    static #instance = null;

    static getInstance(apiManager) {
        if (!TooltipManager.#instance) {
            TooltipManager.#instance = new TooltipManager(apiManager);
        }
        return TooltipManager.#instance;
    }

    constructor(apiManager) {
        this.apiManager = apiManager;
        this.tooltip = null;
        this.currentElement = null;
        this.currentUsername = null;
        this.currentMediaId = null;
        this.state = 'inactive';
        this.timers = new Map();
        this.hoverStates = { icon: false, tooltip: false };
        this.forceVisible = false;

        this.setupGlobalListeners();
        this.startAutoHideChecker();
    }

    setupGlobalListeners() {
        // Use 'pointermove' for better compatibility
        document.addEventListener('pointermove', (e) => {
            this.mousePosition = { x: e.clientX, y: e.clientY };
        });
    }

    handleIconEnter(element, username, mediaId) {
        Logger.log('Icon enter:', username);
        this.hoverStates.icon = true;
        this.forceVisible = false;
        this.clearTimer('hide');
        this.clearTimer('show');

        this.setTimer('show', () => {
            this.show(element, username, mediaId);
        }, CONFIG.TOOLTIP_SHOW_DELAY);
    }

    handleIconLeave() {
        Logger.log('Icon leave');
        this.hoverStates.icon = false;
        this.clearTimer('show');
        if (!this.hoverStates.tooltip && !this.forceVisible) {
            this.setTimer('hide', () => this.hide(), CONFIG.TOOLTIP_HIDE_DELAY);
        }
    }

    handleIconClick(element, username, mediaId) {
        Logger.log('Icon click:', username);
        this.forceVisible = true;
        this.clearTimer('hide');
        this.clearTimer('show');
        this.show(element, username, mediaId);

        // Disable force-visible after a delay
        this.setTimer('force_hide', () => {
            this.forceVisible = false;
        }, 3000);
    }

    show(element, username, mediaId) {
        this.clearTimer('hide');
        this.currentElement = element;
        this.currentUsername = username;
        this.currentMediaId = mediaId;
        this.state = 'showing';

        document.querySelectorAll(SELECTORS.COMMENT_ICON).forEach(icon => {
            icon.classList.remove('active-comment');
        });

        const tooltip = this.getTooltip();
        this.positionTooltip(element);
        tooltip.style.opacity = '0';
        tooltip.style.display = 'block';

        const icon = element.querySelector(SELECTORS.COMMENT_ICON);
        if (icon) icon.classList.add('active-comment');

        requestAnimationFrame(() => {
            tooltip.style.opacity = '1';
            this.state = 'visible';
        });

        this.loadComment(username, mediaId);
    }

    hide(force = false) {
        if ((!force && (this.hoverStates.icon || this.hoverStates.tooltip || this.forceVisible))) {
            return;
        }

        Logger.log('Hiding tooltip');
        if (this.tooltip && this.state !== 'hiding') {
            this.state = 'hiding';
            this.tooltip.style.opacity = '0';

            this.setTimer('transition_end', () => {
                if (this.state === 'hiding' && this.tooltip) {
                    this.tooltip.style.display = 'none';
                    this.currentElement = null;
                    this.currentUsername = null;
                    this.currentMediaId = null;
                    this.state = 'inactive';
                    document.querySelectorAll(SELECTORS.COMMENT_ICON).forEach(icon => {
                        icon.classList.remove('active-comment');
                    });
                }
            }, 300); // 300ms = transition time
        }
    }

    getTooltip() {
        if (!this.tooltip) {
            this.tooltip = document.createElement('div');
            this.tooltip.id = 'anilist-tooltip';
            this.tooltip.className = 'theme-dark'; // Default
            this.tooltip.style.display = 'none';
            this.tooltip.style.opacity = '0';
            document.body.appendChild(this.tooltip);
            this.setupTooltipEvents();
        }
        // TODO: Detect light/dark theme from body
        return this.tooltip;
    }

    setupTooltipEvents() {
        this.tooltip.addEventListener('mouseenter', () => {
            Logger.log('Tooltip enter');
            this.hoverStates.tooltip = true;
            this.clearTimer('hide');
        });
        this.tooltip.addEventListener('mouseleave', () => {
            Logger.log('Tooltip leave');
            this.hoverStates.tooltip = false;
            if (!this.hoverStates.icon && !this.forceVisible) {
                this.setTimer('hide', () => this.hide(), CONFIG.TOOLTIP_HIDE_DELAY);
            }
        });
    }

    positionTooltip(element) {
        const tooltip = this.getTooltip();

        // 1. Find elements: icon, parent row, and the entire section
        const iconRect = element.getBoundingClientRect();
        const parentRow = element.closest('a'); // The entire user row
        const parentRowRect = parentRow ? parentRow.getBoundingClientRect() : iconRect; // Use row, or fallback to icon
        const followingSection = element.closest(SELECTORS.FOLLOWING_SECTION);

        // Default values
        const gap = 15; // Gap from edge
        const tooltipWidth = tooltip.offsetWidth || 265; // 265px from CSS

        let posX = 0;
        let posY = 0;

        // 2. Calculate position
        if (followingSection) {
            // Y-Position = Aligned with the USER ROW (not the icon)
            posY = parentRowRect.top + window.scrollY;

            // X-Position = To the right of the ENTIRE "Following" section
            const followingRect = followingSection.getBoundingClientRect();
            posX = followingRect.right + gap + window.scrollX;
        } else {
            // Fallback (if section not found, anchor to icon)
            posX = iconRect.right + gap + window.scrollX;
            posY = parentRowRect.top + window.scrollY; // Always use row height
            Logger.warn("Following section not found, using fallback positioning.");
        }

        // 3. Apply position (necessary for measurement)
        tooltip.style.left = `${posX}px`;
        tooltip.style.top = `${posY}px`;

        // 4. Collision check (post-render)
        requestAnimationFrame(() => {
            const tooltipRect = tooltip.getBoundingClientRect();
            const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

            // Has it gone off-screen to the RIGHT? (e.g., Sidebar Layout)
            if (tooltipRect.right > (viewportWidth - gap)) {
                // Fallback: move it to the LEFT
                if (followingSection) {
                    const followingRect = followingSection.getBoundingClientRect();
                    posX = followingRect.left - tooltipWidth - gap + window.scrollX;
                } else {
                    // Fallback to parent row's left
                    posX = parentRowRect.left - tooltipWidth - gap + window.scrollX;
                }
                tooltip.style.left = `${posX}px`;
            }

            // Has it gone off-screen at the BOTTOM?
            if (tooltipRect.bottom > (viewportHeight - gap)) {
                // Move it up (aligned to the bottom of the ROW)
                posY = parentRowRect.bottom - tooltipRect.height + window.scrollY;
                tooltip.style.top = `${posY}px`;
            }

            // Has it gone off-screen at the TOP?
            if (tooltipRect.top < (gap + window.scrollY)) {
                // Move it down (aligned to the top of the ROW)
                posY = parentRowRect.top + window.scrollY;
                tooltip.style.top = `${posY}px`;
            }
        });
    }

    loadComment(username, mediaId) {
        const cachedComment = app.cacheManager.get(`${username}-${mediaId}`);
        this.updateTooltipContent(username, mediaId, cachedComment);

        // Fetch if cache is expired (will be handled by updateIfVisible)
        if (!cachedComment?.isValid() && !this.apiManager.isRateLimited) {
            this.apiManager.refreshComment(username, mediaId);
        }
    }

    /**
     * Updates the tooltip content if it's visible and matches the user
     */
    updateIfVisible(username, mediaId, cachedComment) {
        if (
            this.state === 'visible' &&
            this.currentUsername === username &&
            this.currentMediaId === mediaId
        ) {
            Logger.log(`Tooltip refresh for ${username}`);
            this.updateTooltipContent(username, mediaId, cachedComment);
        }
    }

    /**
     * Builds the tooltip DOM
     */
    updateTooltipContent(username, mediaId, cachedComment) {
        const tooltip = this.getTooltip();
        tooltip.innerHTML = ''; // Clear

        const contentDiv = document.createElement('div');
        contentDiv.className = 'tooltip-content';

        const commentText = document.createElement('div');
        const hasComment = cachedComment && cachedComment.hasContent();
        commentText.className = hasComment ? 'comment' : 'no-comment';
        commentText.textContent = hasComment ? cachedComment.content : 'No comment';
        contentDiv.appendChild(commentText);

        const footerDiv = document.createElement('div');
        footerDiv.className = 'tooltip-footer';

        const infoSpan = document.createElement('span');
        infoSpan.className = 'tooltip-info';
        if (cachedComment) {
            const age = cachedComment.getAge();
            if (age > CONFIG.CACHE_MAX_AGE * 0.75) {
                infoSpan.classList.add('cache-warning');
            }
            infoSpan.textContent = `Cached: ${cachedComment.getFormattedAge()}`;
        } else {
            infoSpan.textContent = 'Loading...';
        }

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'tooltip-refresh-btn';
        refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';

        refreshBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Refreshing...';

            const status = await this.apiManager.refreshComment(username, mediaId);

            // 'updateIfVisible' will be called by 'refreshComment'
            // We just need to manage the button state
            if (status === 'success') {
                refreshBtn.classList.add('success');
                refreshBtn.innerHTML = 'Done!';
            } else if (status === 'rate_limited') {
                refreshBtn.classList.add('warning');
                refreshBtn.innerHTML = 'Rate Limit';
            } else {
                refreshBtn.classList.add('error');
                refreshBtn.innerHTML = 'Error';
            }

            // Reset button
            setTimeout(() => {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('success', 'warning', 'error');
                // MODIFICA: Usa Font Awesome invece di ICON_REFRESH_SVG
                refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
            }, 1500);
        });

        footerDiv.appendChild(infoSpan);
        footerDiv.appendChild(refreshBtn);
        tooltip.appendChild(contentDiv);
        tooltip.appendChild(footerDiv);
    }

    startAutoHideChecker() {
        setInterval(() => {
            if (this.state !== 'visible' || !this.currentElement || !this.mousePosition) return;

            const tooltipRect = this.tooltip.getBoundingClientRect();
            const iconRect = this.currentElement.getBoundingClientRect();

            const isInTooltip = this.isPointInRect(this.mousePosition, tooltipRect);
            const isInIcon = this.isPointInRect(this.mousePosition, iconRect);

            if (!this.forceVisible) {
                this.hoverStates.tooltip = isInTooltip;
                this.hoverStates.icon = isInIcon;
                if (!isInTooltip && !isInIcon) {
                    this.hide();
                }
            }
        }, CONFIG.AUTO_HIDE_CHECK_INTERVAL);
    }

    isPointInRect(point, rect) {
        return point.x >= rect.left && point.x <= rect.right &&
            point.y >= rect.top && point.y <= rect.bottom;
    }

    setTimer(name, callback, delay) {
        this.clearTimer(name);
        this.timers.set(name, setTimeout(callback, delay));
    }

    clearTimer(name) {
        if (this.timers.has(name)) {
            clearTimeout(this.timers.get(name));
            this.timers.delete(name);
        }
    }

    destroy() {
        this.timers.forEach(timer => clearTimeout(timer));
        this.timers.clear();
        if (this.tooltip) this.tooltip.remove();
    }
}

/**
 * Global application instance
 */
let app = null;

function initializeApp() {
    if (app) return; // Already initialized

    app = new AnilistHoverComments();
    app.init();

    // Expose app instance for debugging in console
    window.anilistExtension = {
        app: app
    };
}

// Initialize as soon as possible
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (app) app.destroy();
});