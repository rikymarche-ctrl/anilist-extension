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
console.log("Anilist Hover Comments: Loaded!");

/**
 * Configuration constants for application behavior
 */
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const MAX_REQUESTS_PER_MINUTE = 10; // Conservative to avoid rate limiting
const RATE_LIMIT_DURATION = 60000; // 1 minute in milliseconds
const BATCH_DELAY = 200; // Delay between API requests in ms

/**
 * Global state variables
 */
let commentCache = {};
let isInitialized = false;
let isRateLimited = false;
let requestsInLastMinute = 0;
let lastMinuteReset = Date.now();
let lastUrl = location.href;
let lastMediaId = null;
let apiQueue = [];
let processingQueue = false;

/**
 * Loads FontAwesome library for icons if not already present.
 *
 * @returns {void}
 */
function loadFontAwesome() {
    if (document.querySelector('link[href*="fontawesome"]')) return;

    console.log("Loading FontAwesome...");
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css';
    link.crossOrigin = 'anonymous';
    link.referrerPolicy = 'no-referrer';
    document.head.appendChild(link);
}

/**
 * Main initialization function. Sets up the extension on the current page.
 *
 * @returns {void}
 */
function initialize() {
    console.log("Initializing extension");
    loadFontAwesome();

    const media = extractMediaIdFromUrl();
    if (!media) return;

    if (isInitialized) return;

    // Reset all extension state
    resetState();

    // Force cache loading from storage
    loadCacheFromStorage();

    // Find and process the following section
    findFollowingSection(media.id);

    // Set up additional configuration for SPA pages
    observeUrlChanges();

    // Repeat checks after delays to handle slow-loading pages
    setTimeout(() => {
        if (!isInitialized) findFollowingSection(media.id);
    }, 500);

    setTimeout(() => {
        if (!isInitialized) findFollowingSection(media.id);
    }, 1500);
}

/**
 * Finds the "Following" section on the page and processes user entries.
 *
 * @param {number} mediaId - The ID of the current anime or manga
 * @returns {void}
 */
function findFollowingSection(mediaId) {
    console.log("Looking for Following section...");

    // Look for the section by title, then by class
    let followingSection = null;

    // 1. Look for H2 title
    const h2Elements = document.querySelectorAll('h2');
    for (const h2 of h2Elements) {
        if (h2.textContent.includes('Following')) {
            // Look for the div after the h2
            let sibling = h2.nextElementSibling;
            while (sibling) {
                if (sibling.tagName.toLowerCase() === 'div') {
                    followingSection = sibling;
                    break;
                }
                sibling = sibling.nextElementSibling;
            }
            break;
        }
    }

    // 2. If not found, look for class
    if (!followingSection) {
        followingSection = document.querySelector('div.following, div[class="following"], div[class^="following"]');
    }

    if (!followingSection) {
        console.log("Following section not found");
        return;
    }

    console.log("Following section found, looking for users...");

    // Find all user links in the section
    const userLinks = followingSection.querySelectorAll('a[href^="/user/"]');

    console.log(`Found ${userLinks.length} potential user links`);

    if (userLinks.length === 0) return;

    // Process each user entry
    let processedCount = 0;

    userLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (!href) return;

        const username = href.replace('/user/', '').replace(/\/$/, '');

        checkUserComment(link, username, mediaId);
        processedCount++;
    });

    if (processedCount > 0) {
        console.log(`Processed ${processedCount} users`);
        isInitialized = true;
    }
}

/**
 * Resets all extension state and removes any tooltips.
 *
 * @returns {void}
 */
function resetState() {
    const tooltip = document.getElementById('anilist-tooltip');
    if (tooltip) tooltip.remove();

    isRateLimited = false;
    requestsInLastMinute = 0;
    lastMinuteReset = Date.now();
    apiQueue = [];
    processingQueue = false;
}

/**
 * Sets up observers to detect URL changes for Single Page Application support.
 * Re-initializes the extension when navigation occurs.
 *
 * @returns {void}
 */
function observeUrlChanges() {
    const observer = new MutationObserver(() => {
        const currentUrl = location.href;
        const media = extractMediaIdFromUrl();
        const currentMediaId = media?.id;

        if (currentUrl !== lastUrl || currentMediaId !== lastMediaId) {
            console.log("URL or Media ID changed, reinitializing...");

            lastUrl = currentUrl;
            lastMediaId = currentMediaId;
            isInitialized = false;

            if (currentMediaId) {
                setTimeout(initialize, 100);
            }
        }
    });

    observer.observe(document, {
        childList: true,
        subtree: true
    });

    // Add listeners for history and hash changes
    window.addEventListener('popstate', () => {
        isInitialized = false;
        setTimeout(initialize, 100);
    });

    window.addEventListener('hashchange', () => {
        isInitialized = false;
        setTimeout(initialize, 100);
    });
}

/**
 * Checks if a user has a comment for the specified media and adds
 * an icon if needed.
 *
 * @param {HTMLElement} entry - The DOM element representing the user entry
 * @param {string} username - The username to check
 * @param {number} mediaId - The ID of the anime/manga
 * @returns {Promise<void>}
 */
async function checkUserComment(entry, username, mediaId) {
    // Check if the icon already exists
    if (entry.querySelector('.comment-icon-column')) {
        return;
    }

    // Cache key
    const cacheKey = `${username}-${mediaId}`;

    // Check cache first
    let foundInCache = false;
    if (commentCache[cacheKey]) {
        const cache = commentCache[cacheKey];
        const now = Date.now();

        // If cache still valid, check if there's a comment
        if (cache.timestamp && (now - cache.timestamp) < CACHE_MAX_AGE) {
            foundInCache = true;
            if (cache.content && cache.content.trim() !== '') {
                addCommentIcon(entry, username, mediaId);
            }
        }
    }

    // If not found in cache or cache is expired, make API request
    if (!foundInCache) {
        queueApiRequest(entry, username, mediaId);
    }
}

/**
 * Adds a request to the API queue to control request rate.
 *
 * @param {HTMLElement} entry - The DOM element representing the user entry
 * @param {string} username - The username to check
 * @param {number} mediaId - The ID of the anime/manga
 * @returns {void}
 */
function queueApiRequest(entry, username, mediaId) {
    apiQueue.push({ entry, username, mediaId });

    if (!processingQueue) {
        processApiQueue();
    }
}

/**
 * Processes the API request queue with controlled pacing to avoid rate limiting.
 *
 * @returns {Promise<void>}
 */
async function processApiQueue() {
    if (apiQueue.length === 0) {
        processingQueue = false;
        return;
    }

    processingQueue = true;

    // Process requests with delays between them
    const request = apiQueue.shift();

    try {
        // Check rate limit
        const now = Date.now();
        if (now - lastMinuteReset > RATE_LIMIT_DURATION) {
            requestsInLastMinute = 0;
            lastMinuteReset = now;
            isRateLimited = false;
        }

        // If rate limited, requeue and wait
        if (requestsInLastMinute >= MAX_REQUESTS_PER_MINUTE) {
            isRateLimited = true;

            // Requeue the current request
            apiQueue.unshift(request);

            // Wait for rate limit to reset before continuing
            setTimeout(() => {
                isRateLimited = false;
                processApiQueue();
            }, RATE_LIMIT_DURATION);

            return;
        }

        // Increment request counter
        requestsInLastMinute++;

        // Fetch comment from API
        const comment = await fetchUserComment(request.username, request.mediaId);

        // Update cache with new data
        const cacheKey = `${request.username}-${request.mediaId}`;
        commentCache[cacheKey] = {
            content: comment || '',
            timestamp: Date.now()
        };

        // Check from the freshly updated cache
        const cachedContent = commentCache[cacheKey].content;
        if (cachedContent && cachedContent.trim() !== '') {
            addCommentIcon(request.entry, request.username, request.mediaId);
        }

        // Save cache periodically
        if (Object.keys(commentCache).length % 5 === 0) {
            trySaveCacheToStorage();
        }

        // Process next request after delay
        setTimeout(processApiQueue, BATCH_DELAY);

    } catch (error) {
        // Process next request after delay, without logging errors
        setTimeout(processApiQueue, BATCH_DELAY);
    }
}

/**
 * Adds a comment icon to a user entry if they have a comment.
 *
 * @param {HTMLElement} entry - The DOM element representing the user entry
 * @param {string} username - The username
 * @param {number} mediaId - The ID of the anime/manga
 * @returns {void}
 */
function addCommentIcon(entry, username, mediaId) {
    // Check if the icon already exists
    if (entry.querySelector('.anilist-comment-icon')) {
        return;
    }

    // Create icon container
    const iconCol = document.createElement('div');
    iconCol.className = 'comment-icon-column';
    iconCol.dataset.username = username;
    iconCol.dataset.mediaId = mediaId;

    // Create icon
    const commentIcon = document.createElement('i');
    commentIcon.className = 'fa-solid fa-comment anilist-comment-icon';
    iconCol.appendChild(commentIcon);

    // Position the icon container absolutely within the entry
    entry.style.position = 'relative';
    iconCol.style.right = '100px';

    // Append to entry
    entry.appendChild(iconCol);

    // Set up hover listener
    setupHoverListener(iconCol, username, mediaId);
}

/**
 * Tooltip Manager class - Enhanced version with improved priority and better disappearing behavior.
 * Handles the display, positioning, and content of tooltips.
 * Implemented as a singleton to ensure only one tooltip exists.
 */
class TooltipManager {
    static #instance = null;

    /**
     * Gets the singleton instance of the TooltipManager.
     *
     * @returns {TooltipManager} The singleton instance
     */
    static getInstance() {
        if (!TooltipManager.#instance) {
            TooltipManager.#instance = new TooltipManager();
        }
        return TooltipManager.#instance;
    }

    /**
     * Constructor - initializes state and sets up event listeners.
     */
    constructor() {
        this.tooltip = null;
        this.hideTimer = null;
        this.showTimer = null;
        this.autoHideCheckTimer = null;
        this.currentElement = null;
        this.isMouseOverTooltip = false;
        this.isMouseOverIcon = false;
        this.tooltipFadingOut = false;
        this.tooltipState = 'inactive'; // 'inactive', 'showing', 'visible', 'hiding'
        this.lastMousePosition = { x: 0, y: 0 }; // Track last mouse position

        // Add global mouse move listener for hover detection
        document.addEventListener('mousemove', this.handleMouseMove.bind(this));

        // Add global mouseleave to document to detect when mouse leaves window entirely
        document.addEventListener('mouseleave', this.handleDocumentLeave.bind(this));

        // Set up auto hide check timer that runs every 500ms
        this.startAutoHideChecker();
    }

    // Set up auto hide check timer that runs every 500ms
    startAutoHideChecker() {
        if (this.autoHideCheckTimer) {
            clearInterval(this.autoHideCheckTimer);
        }
        this.autoHideCheckTimer = setInterval(() => {
            this.checkAndAutoHide();
        }, 500);

        // Add cleanup when window unloads to prevent memory leaks
        window.addEventListener('beforeunload', () => {
            if (this.autoHideCheckTimer) {
                clearInterval(this.autoHideCheckTimer);
                this.autoHideCheckTimer = null;
            }
        });
    }

    /**
     * Checks if tooltip should be hidden and hides it if necessary
     */
    checkAndAutoHide() {
        if (!this.tooltip || this.tooltip.style.display !== 'block' || this.tooltipState === 'hiding') {
            return;
        }

        // Only proceed if we have a current tooltip and it's visible
        if (this.currentElement && this.tooltip) {
            const tooltipRect = this.tooltip.getBoundingClientRect();
            const iconRect = this.currentElement.getBoundingClientRect();

            // Get current mouse position
            const mouseX = this.lastMousePosition.x;
            const mouseY = this.lastMousePosition.y;

            // Exact check if mouse is inside tooltip or icon - no tolerance
            const isMouseInTooltip = (
                mouseX >= tooltipRect.left &&
                mouseX <= tooltipRect.right &&
                mouseY >= tooltipRect.top &&
                mouseY <= tooltipRect.bottom
            );

            const isMouseInIcon = (
                mouseX >= iconRect.left &&
                mouseX <= iconRect.right &&
                mouseY >= iconRect.top &&
                mouseY <= iconRect.bottom
            );

            // Update state
            this.isMouseOverTooltip = isMouseInTooltip;
            this.isMouseOverIcon = isMouseInIcon;

            // If mouse is not over either element, hide the tooltip
            if (!isMouseInTooltip && !isMouseInIcon) {
                this.hide();
            }
        }
    }

    /**
     * Shows the tooltip for the specified element.
     * Overrides any existing or fading tooltip.
     *
     * @param {HTMLElement} element - The element triggering the tooltip
     * @param {string} username - The username
     * @param {number} mediaId - The ID of the anime/manga
     */
    show(element, username, mediaId) {
        // Immediately interrupt any hiding operation in progress
        this.interruptHiding();

        // Remove active-comment class from ALL icons first to fix highlighting persistence
        document.querySelectorAll('.anilist-comment-icon').forEach(icon => {
            icon.classList.remove('active-comment');
        });

        // Update current state
        this.currentElement = element;
        this.isMouseOverIcon = true;
        this.tooltipState = 'showing';
        this.tooltipFadingOut = false;

        // Get or create tooltip
        const tooltip = this.getTooltip();

        // Force visibility
        tooltip.style.opacity = '0';
        tooltip.style.display = 'block';
        tooltip.classList.add('active'); // Add class to ensure visibility

        // Position tooltip properly - Force immediate positioning
        this.positionTooltip(element);

        // Show loading
        tooltip.innerHTML = "<div class='tooltip-loading'>Loading comment...</div>";

        // Highlight current icon
        const icon = element.querySelector('.anilist-comment-icon');
        if (icon) {
            icon.classList.add('active-comment');
        }

        // Force reflow and fade in with a slight delay to ensure display works
        setTimeout(() => {
            // Reposition again to ensure correct placement
            this.positionTooltip(element);
            tooltip.style.opacity = '1';
            this.tooltipState = 'visible';

            // Load comment
            this.loadComment(username, mediaId);
        }, 50);
    }

    /**
     * Immediately interrupts any hiding operation in progress.
     * This is crucial when switching from one tooltip to another.
     */
    interruptHiding() {
        // Clear any active hide timer
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }

        // Clear any active show timer
        if (this.showTimer) {
            clearTimeout(this.showTimer);
            this.showTimer = null;
        }

        // If tooltip exists and is fading out, stop the operation
        if (this.tooltip && this.tooltipFadingOut) {
            this.tooltip.style.opacity = '1';
            this.tooltipFadingOut = false;
            this.tooltipState = 'visible';
        }
    }

    /**
     * Handles when mouse leaves the document entirely
     */
    handleDocumentLeave() {
        if (this.tooltip && this.tooltip.style.display === 'block') {
            // When mouse leaves document, force hide immediately
            this.isMouseOverTooltip = false;
            this.isMouseOverIcon = false;
            this.hide();
        }
    }

    /**
     * Hides the tooltip with a fade-out animation.
     */
    hide() {
        // Don't hide if mouse is over tooltip or icon
        if (this.isMouseOverTooltip || this.isMouseOverIcon) {
            return;
        }

        // Don't start multiple hide operations
        if (!this.tooltip || this.hideTimer || this.tooltipState === 'hiding') return;

        // Set state to hiding
        this.tooltipState = 'hiding';

        // Almost immediate hide with minimal delay
        this.hideTimer = setTimeout(() => {
            // Double-check mouse state before hiding
            if (!this.isMouseOverTooltip && !this.isMouseOverIcon) {
                if (this.tooltip) {
                    this.tooltipFadingOut = true;
                    this.tooltip.style.opacity = '0';

                    setTimeout(() => {
                        // Final check that another tooltip wasn't requested in the meantime
                        if (this.tooltipFadingOut && this.tooltipState === 'hiding') {
                            this.tooltip.style.display = 'none';
                            this.tooltip.classList.remove('active');

                            // Reset ALL icon highlights
                            document.querySelectorAll('.anilist-comment-icon').forEach(icon => {
                                icon.classList.remove('active-comment');
                            });

                            this.currentElement = null;
                            this.tooltipFadingOut = false;
                            this.tooltipState = 'inactive';
                        }
                        this.hideTimer = null;
                    }, 300); // Match the CSS transition time
                }
            } else {
                // Cancel the hide if mouse moved back over elements
                this.tooltipState = 'visible';
                this.hideTimer = null;
            }
        }, 50); // Very fast hiding initiation
    }

    /**
     * Gets or creates the tooltip element.
     * Enhanced with more robust event handling.
     *
     * @returns {HTMLElement} The tooltip DOM element
     */
    getTooltip() {
        if (!this.tooltip) {
            this.tooltip = document.getElementById('anilist-tooltip');

            if (!this.tooltip) {
                this.tooltip = document.createElement('div');
                this.tooltip.id = 'anilist-tooltip';
                this.tooltip.style.display = 'none';
                this.tooltip.style.opacity = '0';
                this.tooltip.className = 'theme-dark'; // Use site theme
                document.body.appendChild(this.tooltip);

                // Add event listeners with explicit state tracking
                this.tooltip.addEventListener('mouseenter', () => {
                    this.isMouseOverTooltip = true;

                    // Interrupt any hide operation in progress
                    this.interruptHiding();
                });

                this.tooltip.addEventListener('mouseleave', () => {
                    this.isMouseOverTooltip = false;

                    // Only start hiding if mouse is also not over the icon
                    // Use exact check without delay
                    if (!this.isMouseOverIcon) {
                        this.hide();
                    }
                });
            }
        }

        return this.tooltip;
    }

    /**
     * Positions the tooltip next to the element.
     * Enhanced with stability measures to prevent flickering.
     *
     * @param {HTMLElement} element - The element to position the tooltip next to
     */
    positionTooltip(element) {
        const tooltip = this.getTooltip();

        // Find Following section
        const followingSection = document.querySelector(
            'div[class="following"], div.following, [class^="following"], [class*=" following"]'
        );

        if (!followingSection) {
            return;
        }

        // Get Following section dimensions
        const followingRect = followingSection.getBoundingClientRect();

        // HORIZONTAL POSITIONING
        const margin = 20;
        const posX = followingRect.right + margin + window.scrollX;

        // VERTICAL POSITIONING
        const parentEntry = element.closest('a');

        if (!parentEntry) {
            return;
        }

        const parentRect = parentEntry.getBoundingClientRect();
        const posY = window.scrollY + parentRect.top;

        // Check if tooltip is already visible
        const isVisible = tooltip.style.display === 'block' && tooltip.style.opacity !== '0';

        if (isVisible) {
            tooltip.style.transition = "left 0.2s ease, top 0.2s ease, opacity 0.3s ease";
        } else {
            // Disable transitions for initial positioning
            tooltip.style.transition = "none";
        }

        tooltip.style.left = posX + 'px';
        tooltip.style.top = posY + 'px';

        // Re-enable transitions
        if (!isVisible) {
            setTimeout(() => {
                tooltip.style.transition = "left 0.2s ease, top 0.2s ease, opacity 0.3s ease";
            }, 20);
        }
    }

    /**
     * Handles mouse movement to show/hide the tooltip.
     * Enhanced with improved hover detection.
     *
     * @param {MouseEvent} e - The mouse event
     */
    handleMouseMove(e) {
        // Update last known position of mouse
        this.lastMousePosition = {
            x: e.clientX,
            y: e.clientY
        };

        // Skip if tooltip not initialized
        if (!this.tooltip) {
            return;
        }

        // Skip if current element not set
        if (!this.currentElement) {
            return;
        }

        // Check if tooltip is being displayed
        const isTooltipVisible = this.tooltip.style.display === 'block';

        if (isTooltipVisible) {
            const tooltipRect = this.tooltip.getBoundingClientRect();
            const elementRect = this.currentElement.getBoundingClientRect();

            // Exact check if mouse is inside tooltip - no tolerance
            const isMouseInTooltip = (
                e.clientX >= tooltipRect.left &&
                e.clientX <= tooltipRect.right &&
                e.clientY >= tooltipRect.top &&
                e.clientY <= tooltipRect.bottom
            );

            // Exact check if mouse is inside icon - no tolerance
            const isMouseInIcon = (
                e.clientX >= elementRect.left &&
                e.clientX <= elementRect.right &&
                e.clientY >= elementRect.top &&
                e.clientY <= elementRect.bottom
            );

            // Update state
            this.isMouseOverTooltip = isMouseInTooltip;
            this.isMouseOverIcon = isMouseInIcon;

            // Keep visible in safe area
            if (isMouseInTooltip || isMouseInIcon) {
                // Interrupt any hide operation in progress
                this.interruptHiding();
            } else {
                // Start hiding immediately if mouse is outside both elements
                if (!this.hideTimer && this.tooltipState !== 'hiding') {
                    this.hide();
                }
            }
        } else {
            // If tooltip is not visible, reset hover states
            this.isMouseOverTooltip = false;
            this.isMouseOverIcon = false;
        }
    }

    /**
     * Loads comment data and updates the tooltip.
     *
     * @param {string} username - The username
     * @param {number} mediaId - The ID of the anime/manga
     * @returns {Promise<void>}
     */
    async loadComment(username, mediaId) {
        // Cache key
        const cacheKey = `${username}-${mediaId}`;

        // Try cache first
        let comment = null;
        let cacheIsValid = false;
        const now = Date.now();

        // Attempt to load from cache
        if (commentCache[cacheKey]) {
            if (typeof commentCache[cacheKey] === 'object' && commentCache[cacheKey].content !== undefined) {
                comment = commentCache[cacheKey].content;

                // Check if valid
                if (commentCache[cacheKey].timestamp &&
                    (now - commentCache[cacheKey].timestamp) < CACHE_MAX_AGE) {
                    cacheIsValid = true;
                }
            }

            // Show cache content immediately
            if (comment !== null) {
                this.updateTooltipContent(comment, username, mediaId);
            }
        }

        // Get fresh comment if needed and not rate limited
        if (!cacheIsValid && !isRateLimited) {
            try {
                // Check rate limit
                if (now - lastMinuteReset > RATE_LIMIT_DURATION) {
                    requestsInLastMinute = 0;
                    lastMinuteReset = now;
                }

                if (requestsInLastMinute < MAX_REQUESTS_PER_MINUTE) {
                    requestsInLastMinute++;

                    // Fetch fresh comment
                    const freshComment = await fetchUserComment(username, mediaId);

                    // Update cache
                    commentCache[cacheKey] = {
                        content: freshComment || '',
                        timestamp: now
                    };

                    // Update tooltip
                    this.updateTooltipContent(freshComment, username, mediaId);

                    // Try to save to storage
                    trySaveCacheToStorage();
                } else {
                    isRateLimited = true;
                    setTimeout(() => {
                        isRateLimited = false;
                    }, RATE_LIMIT_DURATION);

                    // Show warning
                    if (this.tooltip) {
                        this.tooltip.innerHTML += `
                            <div class="tooltip-warning">
                                <i class="fa-solid fa-exclamation-triangle"></i>
                                API rate limit reached. Using cached version.
                            </div>
                        `;
                    }
                }
            } catch (error) {
                // Show error in tooltip
                if (this.tooltip) {
                    this.tooltip.innerHTML += `
                        <div class="tooltip-error">
                            Error loading comment
                        </div>
                    `;
                }
            }
        } else if (isRateLimited && this.tooltip) {
            // Show rate limit warning if needed
            this.tooltip.innerHTML += `
                <div class="tooltip-warning">
                    <i class="fa-solid fa-exclamation-triangle"></i>
                    API rate limit active. Using cached version.
                </div>
            `;
        }
    }

    /**
     * Updates the tooltip content with the comment data.
     *
     * @param {string} comment - The comment text
     * @param {string} username - The username
     * @param {number} mediaId - The ID of the anime/manga
     */
    updateTooltipContent(comment, username, mediaId) {
        if (!this.tooltip) return;

        this.tooltip.innerHTML = '';

        // Create content container
        const contentDiv = document.createElement('div');
        contentDiv.className = 'tooltip-content';

        // Add comment or placeholder
        if (comment && comment.trim()) {
            const commentDiv = document.createElement('div');
            commentDiv.className = 'comment';
            commentDiv.textContent = comment;
            contentDiv.appendChild(commentDiv);
        } else {
            const noCommentDiv = document.createElement('div');
            noCommentDiv.className = 'no-comment';
            noCommentDiv.textContent = 'No comment';
            contentDiv.appendChild(noCommentDiv);
        }

        this.tooltip.appendChild(contentDiv);

        // Cache info
        let cacheDate = null;
        let cacheAge = null;
        const cacheKey = `${username}-${mediaId}`;

        if (commentCache[cacheKey] && typeof commentCache[cacheKey] === 'object') {
            if (commentCache[cacheKey].timestamp) {
                cacheDate = new Date(commentCache[cacheKey].timestamp);
                const now = Date.now();
                cacheAge = now - commentCache[cacheKey].timestamp;
            }
        }

        // Create footer
        const footerDiv = document.createElement('div');
        footerDiv.className = 'tooltip-footer';

        // Cache info
        const infoSpan = document.createElement('span');
        infoSpan.className = 'tooltip-info';

        if (cacheDate) {
            // Format time
            const timeAgo = getTimeAgo(cacheDate);
            infoSpan.setAttribute('data-timestamp', cacheDate.toISOString());

            // Show warning if old
            if (cacheAge > (CACHE_MAX_AGE * 0.75)) {
                infoSpan.innerHTML = `<i class="fa-solid fa-clock"></i> Cached ${timeAgo}`;
                infoSpan.style.color = "#ffcc00";
            } else {
                infoSpan.textContent = `Cached ${timeAgo}`;
            }
        } else {
            infoSpan.textContent = `${username}'s comment`;
        }

        // Refresh button
        const refreshButton = document.createElement('button');
        refreshButton.className = 'tooltip-refresh-btn';
        refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Refresh';

        // Add refresh handler
        refreshButton.addEventListener('click', async () => {
            refreshButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...';
            refreshButton.disabled = true;

            try {
                // Check if rate limit timer should be reset
                const now = Date.now();
                if (now - lastMinuteReset > RATE_LIMIT_DURATION) {
                    requestsInLastMinute = 0;
                    lastMinuteReset = now;
                }

                // Handle rate limiting with early return instead of exception
                if (requestsInLastMinute >= MAX_REQUESTS_PER_MINUTE) {
                    // Show rate limit error to user
                    refreshButton.innerHTML = '<i class="fa-solid fa-exclamation-circle"></i> Rate Limited';
                    refreshButton.classList.add('error');

                    // Reset button after delay
                    setTimeout(() => {
                        refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Retry';
                        refreshButton.classList.remove('error');
                        refreshButton.disabled = false;
                    }, 2000);

                    return; // Exit function early
                }

                // Increment request counter
                requestsInLastMinute++;

                // Set up fetch with timeout protection
                const fetchPromise = fetchUserComment(username, mediaId);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Request timed out")), 8000)
                );

                // Wait for either successful fetch or timeout, whichever happens first
                const freshComment = await Promise.race([fetchPromise, timeoutPromise]);

                // Store result in cache
                commentCache[cacheKey] = {
                    content: freshComment || '',
                    timestamp: Date.now()
                };

                // Update UI with new content
                this.updateTooltipContent(freshComment, username, mediaId);

                // Persist cache to storage
                trySaveCacheToStorage();

                // Show success indicator
                refreshButton.innerHTML = '<i class="fa-solid fa-check"></i> Updated';
                setTimeout(() => {
                    refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Refresh';
                    refreshButton.disabled = false;
                }, 2000);
            } catch (error) {
                // Handle external errors (network issues, timeout)
                refreshButton.innerHTML = '<i class="fa-solid fa-exclamation-circle"></i> Error';
                refreshButton.classList.add('error');

                // Reset button after delay
                setTimeout(() => {
                    refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Retry';
                    refreshButton.classList.remove('error');
                    refreshButton.disabled = false;
                }, 2000);
            }
        });

        // Add to footer
        footerDiv.appendChild(infoSpan);
        footerDiv.appendChild(refreshButton);

        // Add footer
        this.tooltip.appendChild(footerDiv);
    }
}

/**
 * Sets up hover and click listeners for comment icons.
 * Enhanced version for more stable tooltip behavior with improved priority handling.
 *
 * @param {HTMLElement} element - The element to attach listeners to
 * @param {string} username - The username
 * @param {number} mediaId - The ID of the anime/manga
 */
function setupHoverListener(element, username, mediaId) {
    const tooltipManager = TooltipManager.getInstance();
    const parentEntry = element.closest('a');

    if (parentEntry) {
        // Add hover event for the entire row
        parentEntry.addEventListener("mouseenter", () => {
            // Add a class to highlight the icon when the row is hovered
            const icon = element.querySelector('.anilist-comment-icon');
            if (icon) {
                icon.classList.add('row-hover');
            }
        });

        parentEntry.addEventListener("mouseleave", () => {
            // Remove the class when not hovering the row
            const icon = element.querySelector('.anilist-comment-icon');
            if (icon) {
                icon.classList.remove('row-hover');
            }
        });
    }

    // Icon-specific hover with improved priority handling
    element.addEventListener("mouseenter", (e) => {
        e.stopPropagation();

        // Set hover state immediately
        tooltipManager.isMouseOverIcon = true;

        // Immediately interrupt any hiding operation in progress
        tooltipManager.interruptHiding();

        // Show tooltip with a short delay to ensure intentional hover
        // But first cancel any previous show timer
        if (tooltipManager.showTimer) {
            clearTimeout(tooltipManager.showTimer);
        }

        tooltipManager.showTimer = setTimeout(() => {
            tooltipManager.show(element, username, mediaId);
            tooltipManager.showTimer = null;
        }, 50);
    });

    element.addEventListener("mouseleave", (e) => {
        e.stopPropagation();
        tooltipManager.isMouseOverIcon = false;

        // Cancel any pending show timer
        if (tooltipManager.showTimer) {
            clearTimeout(tooltipManager.showTimer);
            tooltipManager.showTimer = null;
        }

        // Force hide attempt with minimal delay
        setTimeout(() => {
            if (!tooltipManager.isMouseOverTooltip && !tooltipManager.isMouseOverIcon) {
                tooltipManager.hide();
            }
        }, 50);
    });

    // Add click behavior for better accessibility
    element.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();

        // Immediately interrupt any hiding operation in progress
        tooltipManager.interruptHiding();

        // Show tooltip immediately on click without delay
        tooltipManager.show(element, username, mediaId);

        // Keep tooltip visible for a longer time on click
        tooltipManager.stableHoverDelay = 1000; // 1 second delay after click

        // Reset to normal delay after this tooltip session
        setTimeout(() => {
            tooltipManager.stableHoverDelay = 300;
        }, 2000);
    });
}

/**
 * Formats a date into a human-readable "time ago" string.
 *
 * @param {Date} date - The date to format
 * @returns {string} Human-readable time difference
 */
function getTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 30) {
        return "just now";
    } else if (diffSec < 60) {
        return `${diffSec} seconds ago`;
    } else if (diffMin < 60) {
        return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
    } else if (diffHour < 24) {
        return `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago`;
    } else if (diffDay < 30) {
        return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
    } else {
        const options = { day: 'numeric', month: 'short', year: 'numeric' };
        return `on ${date.toLocaleDateString(undefined, options)}`;
    }
}

/**
 * Fetches a user's comment for a specific media from the Anilist API.
 *
 * @param {string} username - The username
 * @param {number} mediaId - The ID of the anime/manga
 * @returns {Promise<string>} The comment text or empty string
 */
async function fetchUserComment(username, mediaId) {
    const query = `
        query ($userName: String, $mediaId: Int) {
            MediaList(userName: $userName, mediaId: $mediaId) {
                notes
            }
        }
    `;

    const variables = { userName: username, mediaId: parseInt(mediaId) };

    try {
        const response = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body: JSON.stringify({ query, variables })
        });

        // If response is not ok, return empty string
        if (!response.ok) {
            if (response.status === 429) {
                isRateLimited = true;
                setTimeout(() => {
                    isRateLimited = false;
                }, RATE_LIMIT_DURATION);
            }
            return "";
        }

        const data = await response.json();

        // If there are errors, return empty string
        if (data.errors) {
            return "";
        }

        // Success
        return data.data?.MediaList?.notes || "";
    } catch (error) {
        // For any error, return empty string
        return "";
    }
}

/**
 * Extracts the media ID and type from the current URL.
 *
 * @returns {Object|null} Object with id and type properties, or null if not found
 */
function extractMediaIdFromUrl() {
    // Check for anime URLs
    let urlMatch = window.location.pathname.match(/\/anime\/(\d+)/);
    if (urlMatch && urlMatch[1]) {
        const id = parseInt(urlMatch[1]);
        if (id > 0) {
            return {
                id: id,
                type: 'ANIME'
            };
        }
    }

    // Check for manga URLs
    urlMatch = window.location.pathname.match(/\/manga\/(\d+)/);
    if (urlMatch && urlMatch[1]) {
        const id = parseInt(urlMatch[1]);
        if (id > 0) {
            return {
                id: id,
                type: 'MANGA'
            };
        }
    }

    // Additional check for other URL patterns
    urlMatch = window.location.pathname.match(/\/(anime|manga)\/.*?\/(\d+)/);
    if (urlMatch && urlMatch[2]) {
        const id = parseInt(urlMatch[2]);
        if (id > 0) {
            return {
                id: id,
                type: urlMatch[1].toUpperCase()
            };
        }
    }

    return null;
}

/**
 * Tries to save the comment cache to localStorage.
 * Uses an alternative approach to avoid "Extension context invalidated" errors.
 *
 * @returns {boolean} True if successful, false otherwise
 */
function trySaveCacheToStorage() {
    // Alternative approach using localStorage to avoid "Extension context invalidated" error
    try {
        localStorage.setItem('anilist_comment_cache', JSON.stringify(commentCache));
        return true;
    } catch (e) {
        // Silently ignore errors
        return false;
    }
}

/**
 * Loads the comment cache from localStorage with fallback handling.
 *
 * @returns {boolean} True if cache was loaded successfully, false otherwise
 */
function loadCacheFromStorage() {
    try {
        const cached = localStorage.getItem('anilist_comment_cache');
        if (cached) {
            try {
                const parsedCache = JSON.parse(cached);
                if (parsedCache && typeof parsedCache === 'object') {
                    commentCache = parsedCache;
                    return true;
                }
            } catch (e) {
                // If JSON is corrupted, initialize empty cache
                commentCache = {};
            }
        }
    } catch (e) {
        // If localStorage fails, initialize empty cache
        commentCache = {};
    }
    return false;
}

/**
 * Event handlers for page initialization
 */
document.addEventListener('DOMContentLoaded', () => {
    // Load cache as soon as possible
    loadCacheFromStorage();
    setTimeout(initialize, 150);
});

// Fallback for pages that load slowly
window.addEventListener('load', () => {
    if (!isInitialized) {
        // Ensure cache is loaded before initializing
        loadCacheFromStorage();
        setTimeout(initialize, 300);
    }
});

/**
 * Cache periodic save
 */
let saveInterval = setInterval(() => {
    try {
        if (Object.keys(commentCache).length > 0) {
            trySaveCacheToStorage();
        }
    } catch (e) {
        // Silently ignore errors
    }
}, 300000); // Every 5 minutes

/**
 * Clean up on unload
 */
window.addEventListener('beforeunload', () => {
    clearInterval(saveInterval);
    if (Object.keys(commentCache).length > 0) {
        trySaveCacheToStorage();
    }
});

/**
 * Immediate initialization after cache load
 */
loadCacheFromStorage();
setTimeout(initialize, 50);