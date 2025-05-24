/**
 * Anilist Hover Comments - Content Script
 *
 * This script enhances Anilist anime/manga pages by displaying user comments via
 * a hover interface. It identifies user entries in the "Following" section and
 * provides a non-intrusive way to view their comments without visiting their profiles.
 *
 * Features:
 * - Shows a comment icon next to user entries with comments
 * - Displays comments in a tooltip on hover or click
 * - Implements a caching system to reduce API requests
 * - Handles SPA (Single Page Application) navigation
 * - Implements rate limiting to avoid API restrictions
 *
 * @author ExAstra
 * @version 1.2.0
 * @see https://github.com/rikymarche-ctrl/anilist-extension
 */

/**
 * Configuration constants for application behavior
 */
const CONFIG = {
    CACHE_MAX_AGE: 24 * 60 * 60 * 1000, // 24 hours
    MAX_REQUESTS_PER_MINUTE: 10, // Conservative to avoid rate limiting
    RATE_LIMIT_DURATION: 60000, // 1 minute in milliseconds
    BATCH_DELAY: 200, // Delay between API requests in ms
    TOOLTIP_SHOW_DELAY: 50,
    TOOLTIP_HIDE_DELAY: 1000, // Increased to 1 second for easier mouse movement
    AUTO_HIDE_CHECK_INTERVAL: 500,
    CACHE_SAVE_INTERVAL: 300000, // 5 minutes
    FONTAWESOME_URL: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css'
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
 * Main application class that manages the entire extension
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
        this.iconManager = new IconManager();
        this.cleanup = [];

        console.log("Anilist Hover Comments: Initialized!");
    }

    /**
     * Initializes the extension
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

            // New approach: Start monitoring immediately for lazy-loaded Following section
            this.startFollowingSectionWatcher(media.id);

        } catch (error) {
            console.warn('Anilist Extension: Initialization failed:', error.message);
        }
    }

    /**
     * Starts watching for the Following section to be lazy-loaded
     */
    startFollowingSectionWatcher(mediaId) {
        console.log('Starting Following section watcher');

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
                            // Check if this node or its children contain Following section or user links
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
                console.log('MutationObserver detected Following section content');
                // Small delay to ensure content is fully rendered
                setTimeout(() => {
                    this.checkForFollowingSection(mediaId);
                }, 100);
            }
        });

        // Monitor the entire document for changes
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Also set up periodic checks as backup
        this.setupPeriodicChecks(mediaId);

        // Clean up observer after reasonable time
        setTimeout(() => {
            if (!this.isInitialized) {
                console.log('Following section watcher timeout');
            }
            observer.disconnect();
        }, 15000);
    }

    /**
     * Checks if a node contains Following section content
     */
    nodeContainsFollowingContent(node) {
        // Check if it's the Following section itself
        if (node.matches && node.matches(SELECTORS.FOLLOWING_SECTION)) {
            return true;
        }

        // Check if it contains Following section
        if (node.querySelector && node.querySelector(SELECTORS.FOLLOWING_SECTION)) {
            return true;
        }

        // Check if it's a user link
        if (node.matches && node.matches(SELECTORS.USER_LINKS)) {
            return true;
        }

        // Check if it contains user links
        if (node.querySelector && node.querySelector(SELECTORS.USER_LINKS)) {
            return true;
        }

        // Check if it's an h2 with "Following" text
        return node.tagName === 'H2' && node.textContent.includes('Following');
    }

    /**
     * Sets up periodic checks as backup
     */
    setupPeriodicChecks(mediaId) {
        const checkIntervals = [500, 1000, 2000, 4000, 8000]; // Progressive delays

        checkIntervals.forEach(delay => {
            setTimeout(() => {
                if (!this.isInitialized) {
                    console.log(`Periodic check at ${delay}ms`);
                    this.checkForFollowingSection(mediaId);
                }
            }, delay);
        });
    }

    /**
     * Checks for Following section and processes it if found
     */
    async checkForFollowingSection(mediaId) {
        const followingSection = this.findFollowingSection();
        if (!followingSection) {
            console.log('Following section not found');
            return false;
        }

        const userLinks = followingSection.querySelectorAll(SELECTORS.USER_LINKS);
        if (userLinks.length === 0) {
            console.log('Following section found but no user links yet');
            return false;
        }

        console.log(`Found Following section with ${userLinks.length} user links - processing immediately`);
        const success = await this.processFollowingSection(mediaId);

        if (success) {
            this.isInitialized = true;
            this.lastMediaId = mediaId;
            console.log('Extension successfully initialized');
            return true;
        }

        return false;
    }

    /**
     * Loads FontAwesome if not already present
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
            link.onerror = resolve; // Continue even if FontAwesome fails
            document.head.appendChild(link);
        });
    }

    /**
     * Processes the following section and sets up comment icons
     */
    async processFollowingSection(mediaId) {
        const followingSection = this.findFollowingSection();
        if (!followingSection) return false;

        const userLinks = followingSection.querySelectorAll(SELECTORS.USER_LINKS);
        if (userLinks.length === 0) return false;

        console.log(`Processing ${userLinks.length} users for media ${mediaId}`);
        let iconsAdded = 0;

        for (const link of userLinks) {
            const username = this.extractUsername(link);
            if (username) {
                const wasProcessed = await this.processUser(link, username, mediaId);
                if (wasProcessed) iconsAdded++;
            }
        }

        console.log(`Added ${iconsAdded} comment icons immediately from cache`);

        // Return true if we found and processed users (even if no icons added yet)
        return userLinks.length > 0;
    }

    /**
     * Finds the following section in the DOM
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
     * Finds following section by looking for H2 title
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
     * Extracts username from user link
     */
    extractUsername(link) {
        const href = link.getAttribute('href');
        if (!href) return null;
        return href.replace('/user/', '').replace(/\/$/, '');
    }

    /**
     * Processes a single user entry
     */
    async processUser(entry, username, mediaId) {
        // Skip if already processed
        if (entry.querySelector(SELECTORS.COMMENT_ICON_COLUMN)) return false;

        const cacheKey = `${username}-${mediaId}`;
        const cachedComment = this.cacheManager.get(cacheKey);
        let iconAdded = false;

        // If we have any cached content (even if expired), show icon immediately
        if (cachedComment && cachedComment.hasContent()) {
            this.iconManager.addIcon(entry, username, mediaId);
            iconAdded = true;
            console.log(`Icon added immediately for ${username} (cached)`);
        }

        // If cache is invalid or doesn't exist, make API request
        if (!cachedComment || !cachedComment.isValid()) {
            this.apiManager.queueRequest(entry, username, mediaId, (hasContent) => {
                if (hasContent && !entry.querySelector(SELECTORS.COMMENT_ICON_COLUMN)) {
                    this.iconManager.addIcon(entry, username, mediaId);
                    console.log(`Icon added via API for ${username}`);
                }
            });
        }

        return iconAdded;
    }

    /**
     * Sets up URL change observer for SPA navigation
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
     * Handles URL changes for SPA navigation
     */
    handleUrlChange() {
        const currentUrl = location.href;
        const media = this.extractMediaFromUrl();
        const currentMediaId = media?.id;

        if (currentUrl !== this.lastUrl || currentMediaId !== this.lastMediaId) {
            console.log('URL/Media change detected, reinitializing');
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
     * Extracts media information from current URL
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
     * Resets extension state
     */
    resetState() {
        // Remove existing tooltip
        const tooltip = document.querySelector(SELECTORS.TOOLTIP);
        if (tooltip) tooltip.remove();

        this.apiManager.reset();
    }

    /**
     * Cleans up resources when extension is destroyed
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
 * Cache manager class for handling comment storage and retrieval
 */
class CacheManager {
    constructor() {
        this.cache = {};
        this.saveInterval = null;
    }

    /**
     * Loads cache from localStorage
     */
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
            console.warn('Cache loading failed:', error.message);
            this.cache = {};
        }

        this.startPeriodicSave();
    }

    /**
     * Gets cached comment data
     */
    get(key) {
        const data = this.cache[key];
        if (!data) return null;

        return new CachedComment(data.content, data.timestamp);
    }

    /**
     * Sets cached comment data
     */
    set(key, content) {
        this.cache[key] = {
            content: content || '',
            timestamp: Date.now()
        };
    }

    /**
     * Saves cache to localStorage
     */
    save() {
        try {
            localStorage.setItem('anilist_comment_cache', JSON.stringify(this.cache));
            return true;
        } catch (error) {
            console.warn('Cache saving failed:', error.message);
            return false;
        }
    }

    /**
     * Starts periodic cache saving
     */
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

    /**
     * Cleans up resources
     */
    destroy() {
        if (this.saveInterval) {
            clearInterval(this.saveInterval);
            this.saveInterval = null;
        }
        this.save(); // Final save
    }
}

/**
 * Represents a cached comment with validation methods
 */
class CachedComment {
    constructor(content, timestamp) {
        this.content = content;
        this.timestamp = timestamp;
    }

    /**
     * Checks if cache is still valid
     */
    isValid() {
        if (!this.timestamp) return false;
        return (Date.now() - this.timestamp) < CONFIG.CACHE_MAX_AGE;
    }

    /**
     * Checks if comment has content
     */
    hasContent() {
        return this.content && this.content.trim() !== '';
    }

    /**
     * Gets age of cache in milliseconds
     */
    getAge() {
        return Date.now() - this.timestamp;
    }

    /**
     * Gets formatted timestamp
     */
    getFormattedAge() {
        return this.formatTimeAgo(new Date(this.timestamp));
    }

    /**
     * Formats time difference into human readable string
     */
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
 * API manager class for handling rate limiting and API requests
 */
class ApiManager {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.requestCount = 0;
        this.lastReset = Date.now();
        this.isRateLimited = false;
    }

    /**
     * Queues an API request
     */
    queueRequest(entry, username, mediaId, callback) {
        this.queue.push({ entry, username, mediaId, callback });

        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    /**
     * Processes the API request queue
     */
    async processQueue() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            if (!this.checkRateLimit()) {
                // Wait for rate limit reset
                setTimeout(() => this.processQueue(), CONFIG.RATE_LIMIT_DURATION);
                return;
            }

            const request = this.queue.shift();
            await this.processRequest(request);

            // Add delay between requests
            if (this.queue.length > 0) {
                await this.delay(CONFIG.BATCH_DELAY);
            }
        }

        this.isProcessing = false;
    }

    /**
     * Processes a single API request
     */
    async processRequest(request) {
        try {
            const { username, mediaId, callback } = request;
            const comment = await this.fetchUserComment(username, mediaId);

            // Update cache
            const cacheKey = `${username}-${mediaId}`;
            app.cacheManager.set(cacheKey, comment);

            // Invoke callback
            if (callback) {
                callback(comment && comment.trim() !== '');
            }

        } catch (error) {
            console.warn(`API request failed for ${request.username}:`, error.message);
        }
    }

    /**
     * Checks and manages rate limiting
     */
    checkRateLimit() {
        const now = Date.now();

        // Reset counter if a minute has passed
        if (now - this.lastReset > CONFIG.RATE_LIMIT_DURATION) {
            this.requestCount = 0;
            this.lastReset = now;
            this.isRateLimited = false;
        }

        // Check if we've exceeded the limit
        if (this.requestCount >= CONFIG.MAX_REQUESTS_PER_MINUTE) {
            this.isRateLimited = true;
            return false;
        }

        this.requestCount++;
        return true;
    }

    /**
     * Fetches user comment from Anilist API
     */
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

    /**
     * Utility delay function
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Resets API manager state
     */
    reset() {
        this.queue = [];
        this.isProcessing = false;
        this.requestCount = 0;
        this.lastReset = Date.now();
        this.isRateLimited = false;
    }

    /**
     * Cleans up resources
     */
    destroy() {
        this.reset();
    }
}

/**
 * Icon manager class for handling comment icon display
 */
class IconManager {
    /**
     * Adds a comment icon to user entry
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
     * Creates icon container element
     */
    createIconContainer(username, mediaId) {
        const container = document.createElement('div');
        container.className = 'comment-icon-column';
        container.dataset.username = username;
        container.dataset.mediaId = mediaId;
        return container;
    }

    /**
     * Creates comment icon element
     */
    createIcon() {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-comment anilist-comment-icon';
        return icon;
    }

    /**
     * Positions icon within entry
     */
    positionIcon(entry, iconContainer) {
        entry.style.position = 'relative';
        iconContainer.style.right = '100px';
    }

    /**
     * Sets up event listeners for icon
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
}

/**
 * Enhanced Tooltip Manager with improved stability and performance
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
        this.state = 'inactive'; // 'inactive', 'showing', 'visible', 'hiding'
        this.timers = new Map();
        this.mousePosition = { x: 0, y: 0 };
        this.hoverStates = {
            icon: false,
            tooltip: false
        };
        this.forceVisible = false; // For debugging state inconsistencies

        this.setupGlobalListeners();
        this.startAutoHideChecker();
    }

    /**
     * Sets up global event listeners
     */
    setupGlobalListeners() {
        document.addEventListener('mousemove', this.handleMouseMove.bind(this));
        document.addEventListener('mouseleave', this.handleDocumentLeave.bind(this));
    }

    /**
     * Handles icon mouse enter
     */
    handleIconEnter(element, username, mediaId) {
        console.log('Icon enter:', username);
        this.hoverStates.icon = true;
        this.forceVisible = false;
        this.clearTimer('hide');
        this.clearTimer('show');

        // Show immediately if already visible for different element
        if (this.tooltip && this.tooltip.style.display === 'block') {
            this.show(element, username, mediaId);
        } else {
            this.setTimer('show', () => {
                this.show(element, username, mediaId);
            }, CONFIG.TOOLTIP_SHOW_DELAY);
        }
    }

    /**
     * Handles icon mouse leave
     */
    handleIconLeave() {
        console.log('Icon leave');
        this.hoverStates.icon = false;
        this.clearTimer('show');

        if (!this.hoverStates.tooltip && !this.forceVisible) {
            this.setTimer('hide', () => {
                this.hide();
            }, CONFIG.TOOLTIP_HIDE_DELAY);
        }
    }

    /**
     * Handles icon click
     */
    handleIconClick(element, username, mediaId) {
        console.log('Icon click:', username);
        this.forceVisible = true; // Keep visible longer on click
        this.clearTimer('hide');
        this.clearTimer('show');
        this.show(element, username, mediaId);

        // Reset force visible after 3 seconds
        setTimeout(() => {
            this.forceVisible = false;
        }, 3000);
    }

    /**
     * Shows tooltip
     */
    show(element, username, mediaId) {
        console.log('Showing tooltip for:', username);
        this.clearTimer('hide');
        this.currentElement = element;
        this.state = 'showing';

        // Clear active states from all icons
        document.querySelectorAll(SELECTORS.COMMENT_ICON).forEach(icon => {
            icon.classList.remove('active-comment');
        });

        const tooltip = this.getTooltip();
        this.positionTooltip(element);

        tooltip.style.opacity = '0';
        tooltip.style.display = 'block';
        tooltip.innerHTML = "<div class='tooltip-loading'>Loading comment...</div>";

        // Highlight current icon
        const icon = element.querySelector(SELECTORS.COMMENT_ICON);
        if (icon) {
            icon.classList.add('active-comment');
            console.log('Icon highlighted for:', username);
        }

        // Fade in
        requestAnimationFrame(() => {
            tooltip.style.opacity = '1';
            this.state = 'visible';
            console.log('Tooltip visible for:', username);
        });

        this.loadComment(username, mediaId);
    }

    /**
     * Hides tooltip
     */
    hide() {
        console.log('Hiding tooltip, states:', this.hoverStates, 'force visible:', this.forceVisible);

        if (this.hoverStates.icon || this.hoverStates.tooltip || this.forceVisible) {
            console.log('Not hiding - still hovering or force visible');
            return;
        }

        if (this.tooltip && this.state !== 'hiding') {
            console.log('Actually hiding tooltip');
            this.state = 'hiding';
            this.tooltip.style.opacity = '0';

            setTimeout(() => {
                if (this.state === 'hiding') {
                    this.tooltip.style.display = 'none';
                    this.currentElement = null;
                    this.state = 'inactive';

                    // Clear icon highlights
                    document.querySelectorAll(SELECTORS.COMMENT_ICON).forEach(icon => {
                        icon.classList.remove('active-comment');
                    });
                    console.log('Tooltip hidden and cleaned up');
                }
            }, 300);
        }
    }

    /**
     * Gets or creates tooltip element
     */
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

    /**
     * Sets up tooltip event listeners
     */
    setupTooltipEvents() {
        this.tooltip.addEventListener('mouseenter', () => {
            console.log('Tooltip enter');
            this.hoverStates.tooltip = true;
            this.clearTimer('hide');
        });

        this.tooltip.addEventListener('mouseleave', () => {
            console.log('Tooltip leave');
            this.hoverStates.tooltip = false;
            if (!this.hoverStates.icon && !this.forceVisible) {
                this.setTimer('hide', () => this.hide(), CONFIG.TOOLTIP_HIDE_DELAY);
            }
        });
    }

    /**
     * Positions tooltip next to element
     */
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

    /**
     * Loads and displays comment
     */
    async loadComment(username, mediaId) {
        const cacheKey = `${username}-${mediaId}`;
        let cachedComment = app.cacheManager.get(cacheKey);

        // Show cached content first if available
        if (cachedComment) {
            this.updateTooltipContent(cachedComment.content, username, mediaId, cachedComment);
        }

        // Fetch fresh content if cache is invalid and not rate limited
        if (!cachedComment?.isValid() && !app.apiManager.isRateLimited) {
            try {
                if (app.apiManager.checkRateLimit()) {
                    const comment = await app.apiManager.fetchUserComment(username, mediaId);
                    app.cacheManager.set(cacheKey, comment);
                    this.updateTooltipContent(comment, username, mediaId, app.cacheManager.get(cacheKey));
                }
            } catch (error) {
                this.showError('Error loading comment');
            }
        }
    }

    /**
     * Updates tooltip content
     */
    updateTooltipContent(comment, username, mediaId, cachedComment) {
        if (!this.tooltip) return;

        this.tooltip.innerHTML = this.createTooltipContent(comment, username, mediaId, cachedComment);
    }

    /**
     * Creates tooltip HTML content
     */
    createTooltipContent(comment, username, mediaId, cachedComment) {
        const hasComment = comment && comment.trim();

        return `<div class="tooltip-content"><div class="${hasComment ? 'comment' : 'no-comment'}">${hasComment ? this.escapeHtml(comment) : 'No comment'}</div></div><div class="tooltip-footer"><span class="tooltip-info">${cachedComment ? this.getFormattedCacheInfo(cachedComment) : `Cached`}</span><button class="tooltip-refresh-btn" onclick="window.anilistExtension.refreshComment('${username}', ${mediaId})"><i class="fa-solid fa-sync"></i> Refresh</button></div>`;
    }

    /**
     * Gets formatted cache information
     */
    getFormattedCacheInfo(cachedComment) {
        const age = cachedComment.getAge();
        const isOld = age > (CONFIG.CACHE_MAX_AGE * 0.75);
        const icon = isOld ? '<i class="fa-solid fa-clock"></i> ' : '';
        const style = isOld ? 'color: #ffcc00;' : '';

        return `<span style="${style}">${icon}Cached ${cachedComment.getFormattedAge()}</span>`;
    }

    /**
     * Shows error message in tooltip
     */
    showError(message) {
        if (this.tooltip) {
            this.tooltip.innerHTML += `<div class="tooltip-error">${message}</div>`;
        }
    }

    /**
     * Escapes HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Handles mouse movement for hover detection
     */
    handleMouseMove(e) {
        this.mousePosition = { x: e.clientX, y: e.clientY };
    }

    /**
     * Handles mouse leaving document
     */
    handleDocumentLeave() {
        console.log('Document leave');
        this.hoverStates.icon = false;
        this.hoverStates.tooltip = false;
        this.forceVisible = false;
        this.hide();
    }

    /**
     * Starts auto hide checker
     */
    startAutoHideChecker() {
        this.autoHideInterval = setInterval(() => {
            this.checkAutoHide();
        }, CONFIG.AUTO_HIDE_CHECK_INTERVAL);
    }

    /**
     * Checks if tooltip should auto-hide
     */
    checkAutoHide() {
        if (!this.tooltip || this.state !== 'visible') return;

        if (this.currentElement) {
            const tooltipRect = this.tooltip.getBoundingClientRect();
            const iconRect = this.currentElement.getBoundingClientRect();

            const isInTooltip = this.isPointInRect(this.mousePosition, tooltipRect);
            const isInIcon = this.isPointInRect(this.mousePosition, iconRect);

            // Update states but don't override if force visible
            if (!this.forceVisible) {
                this.hoverStates.tooltip = isInTooltip;
                this.hoverStates.icon = isInIcon;

                if (!isInTooltip && !isInIcon) {
                    this.hide();
                }
            }

            // Ensure icon highlighting is in sync
            const icon = this.currentElement.querySelector(SELECTORS.COMMENT_ICON);
            if (icon && this.state === 'visible') {
                if (!icon.classList.contains('active-comment')) {
                    console.log('Re-adding active-comment class due to sync issue');
                    icon.classList.add('active-comment');
                }
            }
        }
    }

    /**
     * Checks if point is within rectangle
     */
    isPointInRect(point, rect) {
        return point.x >= rect.left &&
            point.x <= rect.right &&
            point.y >= rect.top &&
            point.y <= rect.bottom;
    }

    /**
     * Timer management utilities
     */
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

    /**
     * Cleans up resources
     */
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
 * Initializes the application
 */
function initializeApp() {
    if (!app) {
        app = new AnilistHoverComments();

        // Expose refresh function globally for tooltip button
        window.anilistExtension = {
            refreshComment: async (username, mediaId) => {
                // Implementation for refresh button
                const cacheKey = `${username}-${mediaId}`;
                try {
                    const comment = await app.apiManager.fetchUserComment(username, mediaId);
                    app.cacheManager.set(cacheKey, comment);

                    // Update tooltip if it's currently showing this comment
                    const tooltipManager = TooltipManager.getInstance();
                    if (tooltipManager.currentElement) {
                        const cachedComment = app.cacheManager.get(cacheKey);
                        tooltipManager.updateTooltipContent(comment, username, mediaId, cachedComment);
                    }
                } catch (error) {
                    console.warn('Comment refresh failed:', error.message);
                }
            }
        };
    }

    // Always try to initialize, let the class handle if it's already initialized
    app.init();
}

/**
 * Event listeners for initialization
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded - initializing extension');
    setTimeout(initializeApp, 50);
});

window.addEventListener('load', () => {
    console.log('Window load event - checking if needs initialization');
    // Always try to initialize on window load as Following section might load later
    setTimeout(initializeApp, 100);
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (app) {
        app.destroy();
    }
});

// Initialize immediately and aggressively for fast loading pages
console.log('Starting immediate initialization');
setTimeout(initializeApp, 10);

// Additional early initialization attempts
setTimeout(initializeApp, 100);
setTimeout(initializeApp, 500);