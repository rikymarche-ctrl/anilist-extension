/**
 * Anilist Hover Comments - Clean Rewrite
 *
 * This script enhances Anilist anime/manga pages by displaying user comments via
 * a hover interface. Rewritten for simplicity and reliability.
 *
 * Features:
 * - Shows a comment icon next to user entries with comments
 * - Displays comments in a tooltip on hover or click
 * - Implements positive and negative caching to minimize API requests
 * - Handles SPA (Single Page Application) navigation
 * - Silent error handling without console pollution
 *
 * @author ExAstra
 * @version 1.3.1
 * @see https://github.com/rikymarche-ctrl/anilist-extension
 */

/**
 * Configuration constants for application behavior
 */
const CONFIG = {
    CACHE_MAX_AGE: 24 * 60 * 60 * 1000, // 24 hours for comments
    NEGATIVE_CACHE_AGE: 60 * 60 * 1000, // 1 hour for "no comment" entries
    MAX_REQUESTS_PER_MINUTE: 10,
    RATE_LIMIT_DURATION: 60000,
    BATCH_DELAY: 200,
    TOOLTIP_SHOW_DELAY: 50,
    TOOLTIP_HIDE_DELAY: 1000,
    AUTO_HIDE_CHECK_INTERVAL: 500,
    CACHE_SAVE_INTERVAL: 300000,
    FONTAWESOME_URL: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css',
    DEBUG_MODE: false
};

/**
 * CSS selectors used throughout the application
 */
const SELECTORS = {
    FOLLOWING_SECTION: 'div.following, div[class="following"], div[class^="following"]',
    USER_LINKS: 'a[href^="/user/"]',
    COMMENT_ICON: '.anilist-comment-icon',
    COMMENT_ICON_COLUMN: '.comment-icon-column',
    TOOLTIP: '#anilist-tooltip',
    FONTAWESOME_LINK: 'link[href*="fontawesome"]'
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
        this.storeMessage('warn', message, args);
    }

    static error(message, ...args) {
        if (CONFIG.DEBUG_MODE) {
            console.error(`[AnilistExt] ${message}`, ...args);
        }
        this.storeMessage('error', message, args);
    }

    static storeMessage(level, message, args) {
        if (!window.anilistExtensionLogs) {
            window.anilistExtensionLogs = [];
        }
        window.anilistExtensionLogs.push({
            level,
            message,
            args,
            timestamp: new Date().toISOString()
        });

        if (window.anilistExtensionLogs.length > 50) {
            window.anilistExtensionLogs = window.anilistExtensionLogs.slice(-50);
        }
    }

    static showLogs() {
        console.table(window.anilistExtensionLogs || []);
    }
}

/**
 * Main application class
 */
class AnilistHoverComments {
    constructor() {
        this.isInitialized = false;
        this.lastUrl = location.href;
        this.lastMediaId = null;
        this.urlObserver = null;
        this.cacheManager = new CacheManager();
        this.apiManager = new ApiManager();
        this.tooltipManager = TooltipManager.getInstance();
        this.cleanup = [];

        // Icon persistence tracking
        this.isFirstTimeLoad = false;
        this.usersWithoutCache = 0;
        this.totalUsers = 0;

        Logger.log("Anilist Hover Comments: Initialized!");
    }

    /**
     * Main initialization
     */
    async init() {
        try {
            await this.loadFontAwesome();
            const media = this.extractMediaFromUrl();

            if (!media) return;

            // Don't re-initialize if already done for this media
            if (this.isInitialized && this.lastMediaId === media.id) return;

            this.resetState();
            await this.cacheManager.load();
            this.setupUrlObserver();

            // Start monitoring for Following section
            this.startFollowingSectionWatcher(media.id);

        } catch (error) {
            Logger.error('Initialization failed:', error.message);
        }
    }

    /**
     * Watch for Following section to appear
     */
    startFollowingSectionWatcher(mediaId) {
        Logger.log('Starting Following section watcher');

        // Try immediate check first
        this.checkForFollowingSection(mediaId);

        // Set up MutationObserver to watch for Following section appearing
        const observer = new MutationObserver((mutations) => {
            if (this.isInitialized) {
                observer.disconnect();
                return;
            }

            let foundNewContent = false;

            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (this.nodeContainsFollowingContent(node)) {
                                foundNewContent = true;
                                break;
                            }
                        }
                    }
                }
                if (foundNewContent) break;
            }

            if (foundNewContent) {
                Logger.log('MutationObserver detected Following section content');
                setTimeout(() => {
                    this.checkForFollowingSection(mediaId);
                }, 100);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Clean up observer after reasonable time
        setTimeout(() => {
            if (!this.isInitialized) {
                Logger.log('Following section watcher timeout');
            }
            observer.disconnect();
        }, 15000);
    }

    /**
     * Check if node contains Following content
     */
    nodeContainsFollowingContent(node) {
        if (node.matches && node.matches(SELECTORS.FOLLOWING_SECTION)) {
            return true;
        }

        if (node.querySelector && node.querySelector(SELECTORS.FOLLOWING_SECTION)) {
            return true;
        }

        if (node.matches && node.matches(SELECTORS.USER_LINKS)) {
            return true;
        }

        if (node.querySelector && node.querySelector(SELECTORS.USER_LINKS)) {
            return true;
        }

        return node.tagName === 'H2' && node.textContent.includes('Following');
    }

    /**
     * Check for Following section and process if found
     */
    async checkForFollowingSection(mediaId) {
        const followingSection = this.findFollowingSection();
        if (!followingSection) {
            Logger.log('Following section not found');
            return false;
        }

        const userLinks = followingSection.querySelectorAll(SELECTORS.USER_LINKS);
        if (userLinks.length === 0) {
            Logger.log('Following section found but no user links yet');
            return false;
        }

        Logger.log(`Found Following section with ${userLinks.length} user links - processing`);
        const success = await this.processFollowingSection(mediaId);

        if (success) {
            this.isInitialized = true;
            this.lastMediaId = mediaId;
            Logger.log('Extension successfully initialized');
            return true;
        }

        return false;
    }

    /**
     * Load FontAwesome if not already present
     */
    async loadFontAwesome() {
        if (document.querySelector(SELECTORS.FONTAWESOME_LINK)) return;

        return new Promise((resolve) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = CONFIG.FONTAWESOME_URL;
            link.crossOrigin = 'anonymous';
            link.referrerPolicy = 'no-referrer';
            link.onload = resolve;
            link.onerror = resolve;
            document.head.appendChild(link);
        });
    }

    /**
     * Process the following section and set up comment icons
     */
    async processFollowingSection(mediaId) {
        const followingSection = this.findFollowingSection();
        if (!followingSection) return false;

        const userLinks = followingSection.querySelectorAll(SELECTORS.USER_LINKS);
        if (userLinks.length === 0) return false;

        Logger.log(`Processing ${userLinks.length} users for media ${mediaId}`);

        // Reset counters for soft refresh tracking
        this.usersWithoutCache = 0;
        this.totalUsers = userLinks.length;
        this.isFirstTimeLoad = false;

        let iconsAdded = 0;

        for (const link of userLinks) {
            const username = this.extractUsername(link);
            if (username) {
                const wasProcessed = await this.processUser(link, username, mediaId);
                if (wasProcessed) iconsAdded++;
            }
        }

        Logger.log(`Added ${iconsAdded} comment icons from cache`);

        // Start API completion monitoring for first-time loads
        if (this.usersWithoutCache === this.totalUsers && this.totalUsers > 0) {
            this.isFirstTimeLoad = true;
            Logger.log('First-time load detected - will RE-PROCESS entire following section after API completion');
            this.scheduleCompleteReprocessing(mediaId);
        }

        return userLinks.length > 0;
    }

    /**
     * Find the following section in the DOM
     */
    findFollowingSection() {
        // Try multiple approaches to find the section
        const approaches = [
            () => this.findByTitle(),
            () => document.querySelector(SELECTORS.FOLLOWING_SECTION)
        ];

        for (const approach of approaches) {
            const section = approach();
            if (section) return section;
        }

        return null;
    }

    /**
     * Find following section by looking for H2 title
     */
    findByTitle() {
        const h2Elements = document.querySelectorAll('h2');
        for (const h2 of h2Elements) {
            if (h2.textContent.includes('Following')) {
                let sibling = h2.nextElementSibling;
                while (sibling) {
                    if (sibling.tagName.toLowerCase() === 'div') {
                        return sibling;
                    }
                    sibling = sibling.nextElementSibling;
                }
            }
        }
        return null;
    }

    /**
     * Start monitoring and re-adding icons as needed (ALWAYS enabled for reliability)
     */
    startIconPersistenceMonitoring(mediaId) {
        Logger.log('Starting icon persistence monitoring for media', mediaId);

        let monitoringAttempts = 0;
        const maxAttempts = 20; // Back to 20 attempts since we're starting after APIs

        const monitorIcons = () => {
            monitoringAttempts++;

            try {
                const followingSection = this.findFollowingSection();
                if (!followingSection) {
                    Logger.log('Following section not found, stopping monitoring');
                    return;
                }

                const userLinks = followingSection.querySelectorAll(SELECTORS.USER_LINKS);
                const existingIcons = followingSection.querySelectorAll(SELECTORS.COMMENT_ICON);

                let iconsAdded = 0;
                let expectedIcons = 0;

                // Check each user and re-add icon if needed
                for (const link of userLinks) {
                    const username = this.extractUsername(link);
                    if (username) {
                        const cacheKey = `${username}-${mediaId}`;
                        const cachedComment = this.cacheManager.get(cacheKey);

                        // If user should have an icon but doesn't
                        if (cachedComment && cachedComment.hasContent()) {
                            expectedIcons++;

                            const hasIcon = link.querySelector(SELECTORS.COMMENT_ICON);
                            if (!hasIcon) {
                                Logger.log(`Re-adding missing icon for ${username} (attempt ${monitoringAttempts})`);
                                this.addIcon(link, username, mediaId);
                                iconsAdded++;
                            }
                        }
                    }
                }

                Logger.log(`Monitor attempt ${monitoringAttempts}: Expected ${expectedIcons}, Found ${existingIcons.length}, Added ${iconsAdded}`);

                // Continue monitoring if we're still missing icons or just added some
                if (monitoringAttempts < maxAttempts && (existingIcons.length < expectedIcons || iconsAdded > 0)) {
                    setTimeout(monitorIcons, 500); // Check every 500ms
                } else {
                    Logger.log(`Icon persistence monitoring completed after ${monitoringAttempts} attempts`);

                    // Final validation
                    const finalIcons = followingSection.querySelectorAll(SELECTORS.COMMENT_ICON);
                    Logger.log(`Final result: ${finalIcons.length} icons persistent`);
                }

            } catch (error) {
                Logger.error('Icon monitoring failed:', error.message);
            }
        };

        // Start monitoring immediately
        monitorIcons();
    }

    /**
     * Monitor API completion and START icon monitoring only after completion
     */
    scheduleApiCompletionMonitoring(mediaId) {
        Logger.log('Waiting for API completion before starting icon monitoring...');

        const checkApiCompletion = () => {
            const pendingRequests = this.apiManager.queue.length + this.apiManager.pendingRequests.size;

            if (pendingRequests === 0) {
                Logger.log('API requests completed - NOW starting icon monitoring');
                // Give APIs a moment to update cache, then start monitoring
                setTimeout(() => {
                    this.startIconPersistenceMonitoring(mediaId);
                }, 500);
            } else {
                Logger.log(`${pendingRequests} API requests still pending - checking again in 1s`);
                setTimeout(checkApiCompletion, 1000);
            }
        };

        // Start checking after a brief delay
        setTimeout(checkApiCompletion, 1000);
    }
    extractUsername(link) {
        const href = link.getAttribute('href');
        if (!href) return null;
        return href.replace('/user/', '').replace(/\/$/, '');
    }

    /**
     * Process a single user entry with negative caching
     */
    async processUser(entry, username, mediaId) {
        // Skip if already processed
        if (entry.querySelector(SELECTORS.COMMENT_ICON_COLUMN)) return false;

        const cacheKey = `${username}-${mediaId}`;
        const cachedComment = this.cacheManager.get(cacheKey);
        let iconAdded = false;

        // Check if user has NO cache at all (for first-time load detection)
        if (!cachedComment) {
            this.usersWithoutCache++;
            Logger.log(`User ${username} has no cache - incrementing counter to ${this.usersWithoutCache}`);
        }

        // If we have cached content, show icon immediately
        if (cachedComment && cachedComment.hasContent()) {
            this.addIcon(entry, username, mediaId);
            iconAdded = true;
            Logger.log(`Icon added immediately for ${username} (cached)`);
        }

        // If cache is invalid or doesn't exist, make API request
        if (!cachedComment || (!cachedComment.isValid() && !cachedComment.isNegativeCacheValid())) {
            this.apiManager.queueRequest(entry, username, mediaId, (hasContent) => {
                if (hasContent && !entry.querySelector(SELECTORS.COMMENT_ICON_COLUMN)) {
                    this.addIcon(entry, username, mediaId);
                    Logger.log(`Icon added via API for ${username}`);
                }
            });
        }

        return iconAdded;
    }

    /**
     * Add a comment icon to user entry (from original code)
     */
    addIcon(entry, username, mediaId) {
        // Skip if icon already exists
        if (entry.querySelector(SELECTORS.COMMENT_ICON)) return;

        const iconContainer = this.createIconContainer(username, mediaId);
        const icon = this.createIcon();

        iconContainer.appendChild(icon);
        this.positionIcon(entry, iconContainer);

        entry.appendChild(iconContainer);
        this.setupIconEvents(iconContainer, username, mediaId);
    }

    /**
     * Create icon container element (from original code)
     */
    createIconContainer(username, mediaId) {
        const container = document.createElement('div');
        container.className = 'comment-icon-column';
        container.dataset.username = username;
        container.dataset.mediaId = mediaId;
        return container;
    }

    /**
     * Create comment icon element (from original code)
     */
    createIcon() {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-comment anilist-comment-icon';
        return icon;
    }

    /**
     * Position icon within entry (from original code)
     */
    positionIcon(entry, iconContainer) {
        entry.style.position = 'relative';
        iconContainer.style.right = '100px';
    }

    /**
     * Set up event listeners for icon (from original code)
     */
    setupIconEvents(iconContainer, username, mediaId) {
        const tooltipManager = TooltipManager.getInstance();
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

        // Icon specific events
        const iconEnterHandler = (e) => {
            e.stopPropagation();
            tooltipManager.handleIconEnter(iconContainer, username, mediaId);
        };

        const iconLeaveHandler = (e) => {
            e.stopPropagation();
            tooltipManager.handleIconLeave();
        };

        const iconClickHandler = (e) => {
            e.stopPropagation();
            e.preventDefault();
            tooltipManager.handleIconClick(iconContainer, username, mediaId);
        };

        iconContainer.addEventListener("mouseenter", iconEnterHandler);
        iconContainer.addEventListener("mouseleave", iconLeaveHandler);
        iconContainer.addEventListener("click", iconClickHandler);
    }

    /**
     * Set up URL change observer for SPA navigation
     */
    setupUrlObserver() {
        // Clean up existing observer
        if (this.urlObserver) {
            this.urlObserver.disconnect();
        }

        this.urlObserver = new MutationObserver(this.handleUrlChange.bind(this));
        this.urlObserver.observe(document, {
            childList: true,
            subtree: true
        });

        // Add event listeners for navigation
        const navigationEvents = ['popstate', 'hashchange'];
        navigationEvents.forEach(event => {
            const handler = () => this.handleUrlChange();
            window.addEventListener(event, handler);
            this.cleanup.push(() => window.removeEventListener(event, handler));
        });
    }

    /**
     * Handle URL changes for SPA navigation
     */
    handleUrlChange() {
        const currentUrl = location.href;
        const media = this.extractMediaFromUrl();
        const currentMediaId = media?.id;

        if (currentUrl !== this.lastUrl || currentMediaId !== this.lastMediaId) {
            Logger.log('URL/Media change detected, reinitializing');
            this.lastUrl = currentUrl;
            this.lastMediaId = currentMediaId;
            this.isInitialized = false;

            if (currentMediaId) {
                // Debounce initialization
                clearTimeout(this.initTimeout);
                this.initTimeout = setTimeout(() => this.init(), 100);
            }
        }
    }

    /**
     * Extract media information from current URL
     */
    extractMediaFromUrl() {
        const patterns = [
            /\/anime\/(\d+)/,
            /\/manga\/(\d+)/,
            /\/(anime|manga)\/.*?\/(\d+)/
        ];

        for (const pattern of patterns) {
            const match = window.location.pathname.match(pattern);
            if (match) {
                const id = parseInt(match[match.length - 1] || match[1]);
                if (id > 0) {
                    return {
                        id,
                        type: match[1]?.toUpperCase() || (pattern.source.includes('anime') ? 'ANIME' : 'MANGA')
                    };
                }
            }
        }

        return null;
    }

    /**
     * Reset extension state
     */
    resetState() {
        // Reset persistence tracking
        this.isFirstTimeLoad = false;
        this.usersWithoutCache = 0;
        this.totalUsers = 0;

        // Remove existing tooltip
        const tooltip = document.querySelector(SELECTORS.TOOLTIP);
        if (tooltip) tooltip.remove();

        this.apiManager.reset();
    }

    /**
     * Clean up resources when extension is destroyed
     */
    destroy() {
        if (this.urlObserver) {
            this.urlObserver.disconnect();
        }

        this.cleanup.forEach(cleanupFn => cleanupFn());
        this.cleanup = [];

        this.cacheManager.destroy();
        this.apiManager.destroy();
        this.tooltipManager.destroy();
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
                const parsedCache = JSON.parse(cached);
                if (parsedCache && typeof parsedCache === 'object') {
                    this.cache = parsedCache;
                }
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
        if (this.saveInterval) {
            clearInterval(this.saveInterval);
        }

        this.saveInterval = setInterval(() => {
            if (Object.keys(this.cache).length > 0) {
                this.save();
            }
        }, CONFIG.CACHE_SAVE_INTERVAL);
    }

    destroy() {
        if (this.saveInterval) {
            clearInterval(this.saveInterval);
            this.saveInterval = null;
        }
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
        if (!this.timestamp) return false;
        return (Date.now() - this.timestamp) < CONFIG.CACHE_MAX_AGE;
    }

    isNegativeCacheValid() {
        if (!this.timestamp || this.hasContent()) return false;
        return (Date.now() - this.timestamp) < CONFIG.NEGATIVE_CACHE_AGE;
    }

    hasContent() {
        return this.content && this.content.trim() !== '';
    }

    getAge() {
        return Date.now() - this.timestamp;
    }

    getFormattedAge() {
        return this.formatTimeAgo(new Date(this.timestamp));
    }

    formatTimeAgo(date) {
        const now = new Date();
        const diffMs = now - date;
        const diffSec = Math.floor(diffMs / 1000);
        const diffMin = Math.floor(diffSec / 60);
        const diffHour = Math.floor(diffMin / 60);
        const diffDay = Math.floor(diffHour / 24);

        if (diffSec < 30) return "just now";
        if (diffSec < 60) return `${diffSec} seconds ago`;
        if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
        if (diffHour < 24) return `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago`;
        if (diffDay < 30) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;

        const options = { day: 'numeric', month: 'short', year: 'numeric' };
        return `on ${date.toLocaleDateString(undefined, options)}`;
    }
}

/**
 * Enhanced API manager with silent error handling
 */
class ApiManager {
    constructor() {
        this.queue = [];
        this.pendingRequests = new Set();
        this.isProcessing = false;
        this.requestCount = 0;
        this.lastReset = Date.now();
        this.isRateLimited = false;
    }

    isPending(username, mediaId) {
        return this.pendingRequests.has(`${username}-${mediaId}`);
    }

    queueRequest(entry, username, mediaId, callback) {
        const requestKey = `${username}-${mediaId}`;

        if (this.pendingRequests.has(requestKey)) {
            return;
        }

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
            await this.processRequest(request);

            if (this.queue.length > 0) {
                await this.delay(CONFIG.BATCH_DELAY);
            }
        }

        this.isProcessing = false;
    }

    async processRequest(request) {
        try {
            const { username, mediaId, callback, requestKey } = request;
            const comment = await this.fetchUserComment(username, mediaId);

            const cacheKey = `${username}-${mediaId}`;
            app.cacheManager.set(cacheKey, comment);

            if (callback) {
                callback(comment && comment.trim() !== '');
            }

        } catch (error) {
            // Silent error handling - cache negative result
            Logger.warn(`API request failed for ${request.username}: ${error.message}`);

            const cacheKey = `${request.username}-${request.mediaId}`;
            app.cacheManager.set(cacheKey, ''); // Empty string = no comment

            if (request.callback) {
                request.callback(false);
            }
        } finally {
            this.pendingRequests.delete(request.requestKey);
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
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body: JSON.stringify({ query, variables })
        });

        if (!response.ok) {
            if (response.status === 429) {
                this.isRateLimited = true;
            }
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (data.errors) {
            throw new Error('GraphQL errors');
        }

        return data.data?.MediaList?.notes || "";
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    reset() {
        this.queue = [];
        this.pendingRequests.clear();
        this.isProcessing = false;
        this.requestCount = 0;
        this.lastReset = Date.now();
        this.isRateLimited = false;
    }

    destroy() {
        this.reset();
    }
}

/**
 * Tooltip Manager (simplified from original)
 */
class TooltipManager {
    static #instance = null;

    static getInstance() {
        if (!TooltipManager.#instance) {
            TooltipManager.#instance = new TooltipManager();
        }
        return TooltipManager.#instance;
    }

    constructor() {
        this.tooltip = null;
        this.currentElement = null;
        this.state = 'inactive';
        this.timers = new Map();
        this.mousePosition = { x: 0, y: 0 };
        this.hoverStates = {
            icon: false,
            tooltip: false
        };
        this.forceVisible = false;

        this.setupGlobalListeners();
        this.startAutoHideChecker();
    }

    setupGlobalListeners() {
        document.addEventListener('mousemove', this.handleMouseMove.bind(this));
        document.addEventListener('mouseleave', this.handleDocumentLeave.bind(this));
    }

    handleIconEnter(element, username, mediaId) {
        console.log('[TOOLTIP DEBUG] Icon enter:', username); // Force console output for debugging
        this.hoverStates.icon = true;
        this.forceVisible = false;
        this.clearTimer('hide');
        this.clearTimer('show');

        if (this.tooltip && this.tooltip.style.display === 'block') {
            this.show(element, username, mediaId);
        } else {
            this.setTimer('show', () => {
                this.show(element, username, mediaId);
            }, CONFIG.TOOLTIP_SHOW_DELAY);
        }
    }

    handleIconLeave() {
        Logger.log('Icon leave');
        this.hoverStates.icon = false;
        this.clearTimer('show');

        if (!this.hoverStates.tooltip && !this.forceVisible) {
            this.setTimer('hide', () => {
                this.hide();
            }, CONFIG.TOOLTIP_HIDE_DELAY);
        }
    }

    handleIconClick(element, username, mediaId) {
        Logger.log('Icon click:', username);
        this.forceVisible = true;
        this.clearTimer('hide');
        this.clearTimer('show');
        this.show(element, username, mediaId);

        setTimeout(() => {
            this.forceVisible = false;
        }, 3000);
    }

    show(element, username, mediaId) {
        console.log('[TOOLTIP DEBUG] Showing tooltip for:', username);
        this.clearTimer('hide');
        this.currentElement = element;
        this.state = 'showing';

        document.querySelectorAll(SELECTORS.COMMENT_ICON).forEach(icon => {
            icon.classList.remove('active-comment');
        });

        const tooltip = this.getTooltip();
        console.log('[TOOLTIP DEBUG] Tooltip element:', tooltip);

        this.positionTooltip(element);

        tooltip.style.opacity = '0';
        tooltip.style.display = 'block';
        tooltip.innerHTML = "<div class='tooltip-loading'>Loading comment...</div>";
        console.log('[TOOLTIP DEBUG] Set loading state');

        const icon = element.querySelector(SELECTORS.COMMENT_ICON);
        if (icon) {
            icon.classList.add('active-comment');
            console.log('[TOOLTIP DEBUG] Icon highlighted for:', username);
        }

        requestAnimationFrame(() => {
            tooltip.style.opacity = '1';
            this.state = 'visible';
            console.log('[TOOLTIP DEBUG] Tooltip visible for:', username);
        });

        this.loadComment(username, mediaId);
    }

    hide() {
        console.log('[TOOLTIP DEBUG] Hiding tooltip, states:', this.hoverStates, 'force visible:', this.forceVisible);

        if (this.hoverStates.icon || this.hoverStates.tooltip || this.forceVisible) {
            console.log('[TOOLTIP DEBUG] Not hiding - still hovering or force visible');
            return;
        }

        if (this.tooltip && this.state !== 'hiding') {
            console.log('[TOOLTIP DEBUG] Actually hiding tooltip');
            this.state = 'hiding';
            this.tooltip.style.opacity = '0';

            setTimeout(() => {
                if (this.state === 'hiding' && this.tooltip) {
                    this.tooltip.style.display = 'none';
                    this.currentElement = null;
                    this.state = 'inactive';

                    document.querySelectorAll(SELECTORS.COMMENT_ICON).forEach(icon => {
                        icon.classList.remove('active-comment');
                    });
                    console.log('[TOOLTIP DEBUG] Tooltip hidden and cleaned up');
                }
            }, 300);
        }
    }

    getTooltip() {
        if (!this.tooltip) {
            this.tooltip = document.getElementById('anilist-tooltip');

            if (!this.tooltip) {
                this.tooltip = document.createElement('div');
                this.tooltip.id = 'anilist-tooltip';
                this.tooltip.className = 'theme-dark';
                this.tooltip.style.display = 'none';
                this.tooltip.style.opacity = '0';
                document.body.appendChild(this.tooltip);

                this.setupTooltipEvents();
            }
        }

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
        const followingSection = document.querySelector(SELECTORS.FOLLOWING_SECTION);

        if (!followingSection) return;

        const followingRect = followingSection.getBoundingClientRect();
        const parentEntry = element.closest('a');

        if (!parentEntry) return;

        const parentRect = parentEntry.getBoundingClientRect();

        const posX = followingRect.right + 20 + window.scrollX;
        const posY = window.scrollY + parentRect.top;

        tooltip.style.left = posX + 'px';
        tooltip.style.top = posY + 'px';
    }

    async loadComment(username, mediaId) {
        console.log('[TOOLTIP DEBUG] Loading comment for:', username);
        const cacheKey = `${username}-${mediaId}`;
        let cachedComment = app.cacheManager.get(cacheKey);

        console.log('[TOOLTIP DEBUG] Cache lookup result:', cachedComment ? 'FOUND' : 'NOT FOUND');

        // Show cached content first if available
        if (cachedComment) {
            console.log('[TOOLTIP DEBUG] Has cached content:', cachedComment.hasContent());
            console.log('[TOOLTIP DEBUG] Cache content preview:', cachedComment.content ? cachedComment.content.substring(0, 50) : 'EMPTY');
            this.updateTooltipContent(cachedComment.content, username, mediaId, cachedComment);
        } else {
            console.log('[TOOLTIP DEBUG] No cache found, showing empty state');
            this.updateTooltipContent('', username, mediaId, null);
        }

        // Fetch fresh content if cache is invalid and not rate limited
        if (!cachedComment?.isValid() && !app.apiManager.isRateLimited) {
            try {
                if (app.apiManager.checkRateLimit()) {
                    console.log('[TOOLTIP DEBUG] Making fresh API request for:', username);
                    const comment = await app.apiManager.fetchUserComment(username, mediaId);
                    app.cacheManager.set(cacheKey, comment);
                    console.log('[TOOLTIP DEBUG] Fresh API result:', comment ? comment.substring(0, 50) : 'EMPTY');
                    this.updateTooltipContent(comment, username, mediaId, app.cacheManager.get(cacheKey));
                } else {
                    console.log('[TOOLTIP DEBUG] Rate limited, cannot fetch fresh content');
                }
            } catch (error) {
                console.error('[TOOLTIP DEBUG] Error loading comment:', error.message);
                this.showError('Error loading comment');
            }
        }
    }

    updateTooltipContent(comment, username, mediaId, cachedComment) {
        console.log('[TOOLTIP DEBUG] Updating tooltip content for:', username);
        console.log('[TOOLTIP DEBUG] Comment to display:', comment ? comment.substring(0, 100) : 'NO COMMENT');

        if (!this.tooltip) {
            console.error('[TOOLTIP DEBUG] No tooltip element found!');
            return;
        }

        const content = this.createTooltipContent(comment, username, mediaId, cachedComment);
        console.log('[TOOLTIP DEBUG] Generated HTML length:', content.length);
        console.log('[TOOLTIP DEBUG] Generated HTML preview:', content.substring(0, 200));

        this.tooltip.innerHTML = content;

        // Verify the update
        const actualContent = this.tooltip.innerHTML;
        console.log('[TOOLTIP DEBUG] Actual tooltip HTML after update:', actualContent.substring(0, 200));

        if (actualContent.includes('Loading comment')) {
            console.warn('[TOOLTIP DEBUG] Tooltip still shows loading state after update!');
        } else {
            console.log('[TOOLTIP DEBUG] Tooltip content updated successfully');
        }
    }

    createTooltipContent(comment, username, mediaId, cachedComment) {
        const hasComment = comment && comment.trim();

        return `<div class="tooltip-content"><div class="${hasComment ? 'comment' : 'no-comment'}">${hasComment ? this.escapeHtml(comment) : 'No comment'}</div></div><div class="tooltip-footer"><span class="tooltip-info">${cachedComment ? this.getFormattedCacheInfo(cachedComment) : `Cached`}</span><button class="tooltip-refresh-btn" onclick="window.anilistExtension.refreshComment('${username}', ${mediaId})"><i class="fa-solid fa-sync"></i> Refresh</button></div>`;
    }

    getFormattedCacheInfo(cachedComment) {
        const age = cachedComment.getAge();
        const isOld = age > (CONFIG.CACHE_MAX_AGE * 0.75);
        const icon = isOld ? '<i class="fa-solid fa-clock"></i> ' : '';
        const style = isOld ? 'color: #ffcc00;' : '';

        return `<span style="${style}">${icon}Cached ${cachedComment.getFormattedAge()}</span>`;
    }

    showError(message) {
        if (this.tooltip) {
            this.tooltip.innerHTML += `<div class="tooltip-error">${message}</div>`;
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    handleMouseMove(e) {
        this.mousePosition = { x: e.clientX, y: e.clientY };
    }

    handleDocumentLeave() {
        Logger.log('Document leave');
        this.hoverStates.icon = false;
        this.hoverStates.tooltip = false;
        this.forceVisible = false;
        this.hide();
    }

    startAutoHideChecker() {
        this.autoHideInterval = setInterval(() => {
            this.checkAutoHide();
        }, CONFIG.AUTO_HIDE_CHECK_INTERVAL);
    }

    checkAutoHide() {
        if (!this.tooltip || this.state !== 'visible') return;

        if (this.currentElement) {
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

            const icon = this.currentElement.querySelector(SELECTORS.COMMENT_ICON);
            if (icon && this.state === 'visible') {
                if (!icon.classList.contains('active-comment')) {
                    Logger.log('Re-adding active-comment class due to sync issue');
                    icon.classList.add('active-comment');
                }
            }
        }
    }

    isPointInRect(point, rect) {
        return point.x >= rect.left &&
            point.x <= rect.right &&
            point.y >= rect.top &&
            point.y <= rect.bottom;
    }

    setTimer(name, callback, delay) {
        this.clearTimer(name);
        this.timers.set(name, setTimeout(callback, delay));
    }

    clearTimer(name) {
        const timer = this.timers.get(name);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(name);
        }
    }

    destroy() {
        this.timers.forEach(timer => clearTimeout(timer));
        this.timers.clear();

        if (this.autoHideInterval) {
            clearInterval(this.autoHideInterval);
        }

        if (this.tooltip) {
            this.tooltip.remove();
            this.tooltip = null;
        }
    }
}

/**
 * Global application instance
 */
let app = null;

/**
 * Initialize the application
 */
function initializeApp() {
    if (!app) {
        app = new AnilistHoverComments();

        // Expose refresh function globally for tooltip button
        window.anilistExtension = {
            refreshComment: async (username, mediaId) => {
                const cacheKey = `${username}-${mediaId}`;
                try {
                    const comment = await app.apiManager.fetchUserComment(username, mediaId);
                    app.cacheManager.set(cacheKey, comment);

                    const tooltipManager = TooltipManager.getInstance();
                    if (tooltipManager.currentElement) {
                        const cachedComment = app.cacheManager.get(cacheKey);
                        tooltipManager.updateTooltipContent(comment, username, mediaId, cachedComment);
                    }
                } catch (error) {
                    Logger.warn('Comment refresh failed:', error.message);
                }
            },

            enableDebug: () => {
                CONFIG.DEBUG_MODE = true;
                console.log('[AnilistExt] Debug mode enabled. Reload page for full debug output.');
            },

            showLogs: () => {
                Logger.showLogs();
            }
        };
    }

    app.init();
}

/**
 * Event listeners for initialization
 */
document.addEventListener('DOMContentLoaded', () => {
    Logger.log('DOMContentLoaded - initializing extension');
    setTimeout(initializeApp, 50);
});

window.addEventListener('load', () => {
    Logger.log('Window load event - checking if needs initialization');
    setTimeout(initializeApp, 100);
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (app) {
        app.destroy();
    }
});

// Initialize immediately and aggressively for fast loading pages
Logger.log('Starting immediate initialization');
setTimeout(initializeApp, 10);

// Additional early initialization attempts
setTimeout(initializeApp, 100);
setTimeout(initializeApp, 500);