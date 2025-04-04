// Content script for Anilist Hover Comments
console.log("Content script successfully loaded!");

// Configuration constants for cache management
const DEBUG = false;
const FORCE_DEBUG = false; // Set to false in production

const MAX_WAIT_TIME = 30000; // 30 seconds maximum wait time for Following section

// Cache constants
const CACHE_MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours
const MAX_CACHE_SIZE_BYTES = 100 * 1024;
const MAX_CACHE_ENTRIES = 250;
const CACHE_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes

// API Request management
const MIN_REQUEST_DELAY = 2000; // 2 seconds between requests
const MAX_REQUESTS_PER_MINUTE = 20;
const BATCH_SIZE = 4; // Process this many requests in parallel
const BATCH_COOLDOWN = 3000; // Wait between batches (ms)
const MIN_BATCH_SPREAD = 300; // Minimum ms between requests in a batch

// Retry configuration
const MAX_RETRIES = 1; // 2 attempts total: initial + 1 retry
const RETRY_DELAY_BASE = 2000;
const RETRY_DELAY_FACTOR = 2; // Exponential backoff

// Global variables
let commentCache = {};
let mediaUserMap = {};
let cacheCleanupTimer = null;
let lastRequestTime = 0;
let pendingRequests = [];
let processingRequests = false;
let requestsInLastMinute = 0;
let lastMinuteReset = Date.now();
let activeBatchCount = 0;
let isInitialized = false;
let isAnimePage = false;
let isPollingActive = false;
let globalObserver = null;
let urlObserver = null;
let currentUsername = null;
let isRateLimited = false;
let rateLimitResetTime = null;
let lastUrl = location.href;
let lastMediaId = null;

// Helper function to check if extension context is still valid
function isExtensionContextValid() {
    try {
        return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
        return false;
    }
}

// Load Font Awesome CSS
function loadFontAwesome() {
    if (document.querySelector('link[href*="fontawesome"]')) {
        if (DEBUG) console.log("Font Awesome already loaded on the page");
        return;
    }

    if (DEBUG) console.log("Loading Font Awesome...");

    const fontAwesomeLink = document.createElement("link");
    fontAwesomeLink.rel = "stylesheet";
    fontAwesomeLink.href = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css";
    fontAwesomeLink.integrity = "sha512-z3gLpd7yknf1YoNbCzqRKc4qyor8gaKU1qmn+CShxbuBusANI9QpRohGBreCFkKxLhei6S9CQXFEbbKuqLg0DA==";
    fontAwesomeLink.crossOrigin = "anonymous";
    fontAwesomeLink.referrerPolicy = "no-referrer";

    document.head.appendChild(fontAwesomeLink);
    if (DEBUG) console.log("Font Awesome loaded successfully");
}

// Debounce utility function
function debounce(func, wait) {
    let timeout;
    return function() {
        const context = this, args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(context, args);
        }, wait);
    };
}

// Extract media ID from URL with validation
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

// URL change detection
function handleUrlChange() {
    const currentUrl = location.href;
    const currentMediaInfo = extractMediaIdFromUrl();
    const currentMediaId = currentMediaInfo ? currentMediaInfo.id : null;

    // Check for navigation
    if (currentUrl !== lastUrl || currentMediaId !== lastMediaId) {
        if (DEBUG) {
            console.log("Navigation detected:", {
                from: { url: lastUrl, mediaId: lastMediaId },
                to: { url: currentUrl, mediaId: currentMediaId }
            });
        }

        // Update tracking variables
        lastUrl = currentUrl;
        lastMediaId = currentMediaId;

        // Reset extension state completely
        resetExtensionState();

        // Restart with a delay
        setTimeout(() => {
            if (isExtensionContextValid()) {
                initializeExtension();
            }
        }, 300);
    }
}

// Setup enhanced URL observer
function setupUrlObserver() {
    // Disconnect existing observer
    if (urlObserver) {
        urlObserver.disconnect();
    }

    // Create new observer
    const observer = new MutationObserver(() => {
        handleUrlChange();
    });

    // Observe DOM changes
    observer.observe(document, {
        subtree: true,
        childList: true
    });

    return observer;
}

// Setup navigation listeners
function setupNavigationListeners() {
    // Listen for history events
    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);

    // Periodic check for SPA navigation
    setInterval(handleUrlChange, 2000);
}

// Stop all detection systems
function stopDetection() {
    if (globalObserver) {
        globalObserver.disconnect();
        globalObserver = null;
    }
}

// Persistent detection system for the Following section
function startPersistentDetection(mediaId) {
    console.log("Starting persistent detection system...");

    // 1. Try immediately
    checkForFollowingSection(mediaId);

    // 2. Create a global observer
    globalObserver = new MutationObserver((mutations) => {
        if (!isInitialized) {
            for (const mutation of mutations) {
                // Check added nodes
                if (mutation.addedNodes.length) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.querySelector &&
                                (node.classList?.contains('following') ||
                                    node.querySelector?.('div[class="following"]'))) {
                                checkForFollowingSection(mediaId);
                                break;
                            }
                        }
                    }
                }

                // Check modified targets
                if (mutation.target.nodeType === Node.ELEMENT_NODE &&
                    mutation.target.querySelector &&
                    mutation.target.querySelector('div[class="following"]')) {
                    checkForFollowingSection(mediaId);
                }
            }
        } else {
            globalObserver.disconnect();
        }
    });

    // Observe DOM changes
    globalObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: false
    });

    // 3. Start progressive polling
    startProgressivePolling(mediaId);

    // 4. Set final timeout
    setTimeout(() => {
        if (!isInitialized && document.querySelector('div[class="following"]')) {
            if (DEBUG) console.log("Final check for Following section after timeout");
            checkForFollowingSection(mediaId, true); // Force check
        }
    }, MAX_WAIT_TIME);
}

// Progressive polling
function startProgressivePolling(mediaId) {
    if (isPollingActive) return;
    isPollingActive = true;

    const intervals = [1000, 2000, 3000, 5000, 8000, 10000, 15000];
    let currentInterval = 0;

    function poll() {
        if (isInitialized) {
            isPollingActive = false;
            return;
        }

        if (currentInterval >= intervals.length) {
            isPollingActive = false;
            return;
        }

        const found = checkForFollowingSection(mediaId);

        if (!found) {
            setTimeout(() => {
                currentInterval++;
                poll();
            }, intervals[currentInterval]);
        } else {
            isPollingActive = false;
        }
    }

    poll(); // Start polling
}

// Check for Following section
function checkForFollowingSection(mediaId, forceCheck = false) {
    if (isInitialized && !forceCheck) return false;

    // Try different selectors
    const selectors = [
        'div[class="following"]',
        'div.following',
        '[class^="following"]',
        '[class*=" following"]'
    ];

    let followingSection = null;

    // Find the section
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
            followingSection = element;
            break;
        }
    }

    if (followingSection) {
        if (DEBUG) console.log("Following section found, checking for user entries");

        // Short delay to ensure entries are loaded
        setTimeout(() => {
            // User entry selectors
            const userEntrySelectors = [
                'a[class="follow"]',
                'a.follow',
                'a[class^="follow"]',
                'a.user',
                'a[class*="user"]',
                'a:has(div[class="name"])'
            ];

            let userEntries = [];

            // Find user entries
            for (const selector of userEntrySelectors) {
                try {
                    const entries = followingSection.querySelectorAll(selector);
                    if (entries.length > 0) {
                        userEntries = [...userEntries, ...Array.from(entries)];
                    }
                } catch (e) {
                    // Some selectors might not be supported
                }
            }

            // Deduplicate entries
            const uniqueEntries = [];
            const seenElements = new Set();

            for (const entry of userEntries) {
                const entryId = entry.textContent?.trim() || entry.innerHTML;
                if (!seenElements.has(entryId)) {
                    seenElements.add(entryId);
                    uniqueEntries.push(entry);
                }
            }

            userEntries = uniqueEntries;

            if (userEntries.length > 0) {
                if (DEBUG) console.log(`Following section found with ${userEntries.length} users`);
                setupFollowingSection(followingSection, userEntries, mediaId);
                stopDetection();
                return true;
            }
        }, 300);
    }

    return false;
}

// Setup Following section
function setupFollowingSection(followingSection, userEntries, mediaId) {
    // Prevent duplicate initialization
    if (isInitialized) return;

    if (DEBUG) console.log("Setting up listeners for the Following section...");

    // Validate input
    if (userEntries.length === 0) {
        console.log("No user entries found, initialization aborted");
        return;
    }

    // Add rate limit warning if needed
    if (isRateLimited) {
        addRateLimitWarning(followingSection);
    }

    // Queue for processing
    const processQueue = [];

    // Process all users
    for (const entry of userEntries) {
        const nameElement = entry.querySelector("div[class='name']");
        if (nameElement) {
            const username = nameElement.textContent.trim();

            // Priority (current user first)
            const priority = (username === currentUsername) ? 1 : 2;

            processQueue.push({ entry, username, priority });

            // Process current user immediately
            if (username === currentUsername) {
                if (DEBUG) console.log(`Found current user (${username}) entry, processing immediately`);
                checkCurrentUserComment(entry, username, mediaId);
            }
        }
    }

    // Sort by priority
    processQueue.sort((a, b) => a.priority - b.priority);

    // Process queue
    for (const { entry, username } of processQueue) {
        // Skip current user (already processed)
        if (username === currentUsername) continue;

        const cacheKey = `${username}-${mediaId}`;

        // Check cache first
        if (commentCache[cacheKey]) {
            const hasComment = hasCachedComment(cacheKey);
            const commentContent = getCachedComment(cacheKey, false); // Disable validation

            if (hasComment) {
                if (DEBUG) console.log(`Adding comment icon for ${username} from cache`);
                addCommentIcon(entry, username, mediaId, true, commentContent);

                // Skip API if cache is valid
                const now = Date.now();
                const cacheIsValid = typeof commentCache[cacheKey] === 'object' &&
                    commentCache[cacheKey].timestamp &&
                    (now - commentCache[cacheKey].timestamp) < CACHE_MAX_AGE;

                if (cacheIsValid) {
                    if (DEBUG) console.log(`Using valid cache for ${username}, skipping API request`);
                    continue;
                }
            }
        }

        // Queue API request
        queueApiRequest({
            type: 'checkComment',
            username,
            mediaId,
            entry,
            priority: username === currentUsername ? 1 : 3
        });
    }

    // Start processing
    startProcessingRequests();

    // Mark as initialized
    isInitialized = true;
    if (DEBUG) console.log("Initialization completed successfully!");
}

// Check current user's comment (immediate processing)
async function checkCurrentUserComment(entry, username, mediaId) {
    if (!username || !mediaId) return;

    if (DEBUG) console.log(`Checking current user (${username}) comment for media ${mediaId}`);

    // Try to get comment from page
    let comment = '';
    const notesElement = document.querySelector('textarea[name="notes"], div.notes');
    if (notesElement && notesElement.value) {
        comment = notesElement.value;
    } else if (notesElement && notesElement.textContent) {
        comment = notesElement.textContent;
    }

    // Try API if not found on page
    if (!comment) {
        try {
            if (DEBUG) console.log(`No comment found on page, trying API for user ${username}`);
            comment = await fetchUserComment(username, mediaId);
        } catch (error) {
            console.error("Error fetching current user comment:", error);
            return;
        }
    }

    // Update cache
    const cacheKey = `${username}-${mediaId}`;
    commentCache[cacheKey] = {
        content: comment,
        timestamp: Date.now()
    };

    // Add icon if comment exists
    if (comment && comment.trim() !== '') {
        if (DEBUG) console.log(`Current user has comment for media ${mediaId}: "${comment}"`);
        addCommentIcon(entry, username, mediaId, true, comment);
        saveCache();
    } else {
        if (DEBUG) console.log(`Current user has no comment for media ${mediaId}`);
    }
}

// Add comment icon
function addCommentIcon(entry, username, mediaId, hasComment, commentContent) {
    // Only proceed if still in DOM
    if (!entry || !entry.isConnected) {
        if (DEBUG) console.log(`Entry for ${username} is no longer in the DOM, skipping icon addition`);
        return;
    }

    const scoreElement = entry.querySelector("span");
    const statusElement = entry.querySelector("div[class='status']");
    const isCurrentUser = (username === currentUsername);

    if (hasComment) {
        // Check for existing icon
        if (entry.querySelector(".comment-icon-column")) {
            if (DEBUG) console.log(`Icon already exists for ${username}, skipping`);
            return;
        }

        // Set position relative
        if (window.getComputedStyle(entry).position === 'static') {
            entry.style.position = 'relative';
        }

        // Create icon column
        const iconColumn = document.createElement("div");
        iconColumn.className = "comment-icon-column";
        iconColumn.style.position = "absolute";
        iconColumn.style.top = "50%";
        iconColumn.style.transform = "translateY(-50%)";

        // Position based on status element
        if (statusElement) {
            const statusRect = statusElement.getBoundingClientRect();
            const entryRect = entry.getBoundingClientRect();
            iconColumn.style.right = `${entryRect.right - statusRect.right + 10}px`;
        } else {
            iconColumn.style.right = "60px";
        }

        // Create icon
        const commentIcon = document.createElement("i");
        commentIcon.className = "fa-solid fa-comment anilist-comment-icon";
        commentIcon.style.fontSize = "14px";
        commentIcon.style.cursor = "pointer";
        commentIcon.style.display = "inline-block";
        commentIcon.style.visibility = "visible";

        // Add to column
        iconColumn.appendChild(commentIcon);

        // Stop click propagation
        iconColumn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        // Add to entry
        entry.appendChild(iconColumn);

        // Setup hover
        setupHoverListener(iconColumn, username, mediaId, commentContent);
    }
}

// Add rate limit warning
function addRateLimitWarning(followingSection) {
    const warningDiv = document.createElement('div');
    warningDiv.className = 'rate-limit-warning';
    warningDiv.style.backgroundColor = 'rgba(255, 50, 50, 0.1)';
    warningDiv.style.border = '1px solid rgba(255, 50, 50, 0.3)';
    warningDiv.style.borderRadius = '4px';
    warningDiv.style.padding = '10px';
    warningDiv.style.marginBottom = '15px';
    warningDiv.style.fontSize = '14px';

    let resetMessage = '';
    if (rateLimitResetTime) {
        const resetMinutes = Math.ceil((rateLimitResetTime - Date.now()) / 60000);
        resetMessage = ` Please try again in approximately ${resetMinutes} minute${resetMinutes !== 1 ? 's' : ''}.`;
    }

    warningDiv.textContent = `Anilist API rate limit reached. Some comments may not be visible.${resetMessage}`;

    // Insert before the following section
    followingSection.parentNode.insertBefore(warningDiv, followingSection);
}

// Tooltip content update
window.updateTooltipContent = function(tooltip, comment, username, mediaId) {
    tooltip.textContent = "";

    // Header removed as requested

    // Create container
    const contentContainer = document.createElement("div");
    contentContainer.className = "tooltip-content";

    // Basic media ID check (less restrictive)
    const currentPath = window.location.pathname;
    const currentMediaMatch = currentPath.match(/\/(anime|manga)\/(\d+)/);
    const currentMediaId = currentMediaMatch ? parseInt(currentMediaMatch[2]) : null;

    // Store username/mediaId as data attributes for sync updates
    tooltip.setAttribute('data-username', username);
    tooltip.setAttribute('data-media-id', mediaId);

    // No username display - display comment directly
    // Display comment
    if (comment && comment.trim() !== "") {
        const commentDiv = document.createElement("div");
        commentDiv.className = "comment";
        commentDiv.textContent = comment;
        contentContainer.appendChild(commentDiv);

        // Add warning only for obvious mismatches
        if (currentMediaId && mediaId && currentMediaId !== mediaId && Math.abs(currentMediaId - mediaId) > 10000) {
            const warningDiv = document.createElement("div");
            warningDiv.className = "tooltip-warning";
            warningDiv.style.fontSize = "10px";
            warningDiv.style.marginTop = "5px";
            warningDiv.innerHTML = '<i class="fa-solid fa-info-circle"></i> This comment might be for a different anime/manga.';
            contentContainer.appendChild(warningDiv);

            if (DEBUG) console.log(`Possible mismatch: page ID ${currentMediaId}, comment for ID ${mediaId}`);
        }
    } else {
        const noCommentDiv = document.createElement("div");
        noCommentDiv.className = "no-comment";
        noCommentDiv.textContent = "No comment";
        contentContainer.appendChild(noCommentDiv);
    }

    // Add container
    tooltip.appendChild(contentContainer);

    // Cache info
    let cacheDate = null;
    let cacheAge = null;
    const cacheKey = `${username}-${mediaId}`;

    if (commentCache[cacheKey]) {
        if (typeof commentCache[cacheKey] === 'object' && commentCache[cacheKey].timestamp) {
            cacheDate = new Date(commentCache[cacheKey].timestamp);
            const now = Date.now();
            cacheAge = now - commentCache[cacheKey].timestamp;
        }
    }

    // Add footer
    const footerDiv = document.createElement("div");
    footerDiv.className = "tooltip-footer";

    // Cache info text
    const infoSpan = document.createElement("span");
    infoSpan.className = "tooltip-info";

    if (cacheDate) {
        // Format age
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
    const refreshButton = document.createElement("button");
    refreshButton.className = "tooltip-refresh-btn";
    refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Refresh';

    // Refresh handler
    const handleRefresh = async () => {
        refreshButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...';
        refreshButton.disabled = true;

        try {
            // Fetch with timeout
            const fetchPromise = fetchUserComment(username, mediaId);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Request timed out")), 8000)
            );

            const freshComment = await Promise.race([fetchPromise, timeoutPromise]);

            // Update cache
            const cacheKey = `${username}-${mediaId}`;
            const now = Date.now();

            commentCache[cacheKey] = {
                content: freshComment || '',
                timestamp: now
            };

            saveCache();

            // Update content
            const contentDiv = tooltip.querySelector(".tooltip-content");
            if (contentDiv) {
                contentDiv.innerHTML = "";

                if (freshComment && freshComment.trim() !== "") {
                    const commentDiv = document.createElement("div");
                    commentDiv.className = "comment";
                    commentDiv.textContent = freshComment;
                    contentDiv.appendChild(commentDiv);
                } else {
                    const noCommentDiv = document.createElement("div");
                    noCommentDiv.className = "no-comment";
                    noCommentDiv.textContent = "No comment";
                    contentDiv.appendChild(noCommentDiv);
                }
            }

            // Update cache info
            const infoSpan = tooltip.querySelector(".tooltip-info");
            if (infoSpan) {
                infoSpan.textContent = `Cached just now`;
                infoSpan.style.color = "";
            }

            // Reset button
            refreshButton.innerHTML = '<i class="fa-solid fa-check"></i> Updated';
            setTimeout(() => {
                refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Refresh';
                refreshButton.disabled = false;
            }, 2000);
        } catch (error) {
            console.error("Error refreshing comment:", error);

            // Error handling
            refreshButton.innerHTML = '<i class="fa-solid fa-exclamation-circle"></i> Error';
            refreshButton.classList.add('error');

            setTimeout(() => {
                refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Retry';
                refreshButton.classList.remove('error');
                refreshButton.disabled = false;
            }, 2000);
        }
    };

    // Add event listener
    refreshButton.addEventListener("click", handleRefresh);

    // Add to footer
    footerDiv.appendChild(infoSpan);
    footerDiv.appendChild(refreshButton);

    // Add footer
    tooltip.appendChild(footerDiv);
};

// Format time ago
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

// Queue API request
function queueApiRequest(request) {
    // Skip if rate limited
    if (isRateLimited) {
        if (DEBUG) console.log(`Skipping API request for ${request.username} due to rate limit`);
        return;
    }

    // Add to queue
    pendingRequests.push(request);

    // Sort by priority
    pendingRequests.sort((a, b) => a.priority - b.priority);

    if (DEBUG) console.log(`Queued API request for ${request.username}, queue length: ${pendingRequests.length}`);
}

// Start processing requests
function startProcessingRequests() {
    if (processingRequests || pendingRequests.length === 0 || isRateLimited) return;

    // Optimize queue
    optimizeRequestQueue();

    if (pendingRequests.length === 0) return;

    processingRequests = true;
    processNextBatch();
}

// Optimize request queue
function optimizeRequestQueue() {
    if (pendingRequests.length <= 1) return;

    const optimizedQueue = [];
    const processedKeys = new Set();

    // Sort by priority
    pendingRequests.sort((a, b) => a.priority - b.priority);

    for (const request of pendingRequests) {
        const cacheKey = `${request.username}-${request.mediaId}`;

        // Skip duplicates
        if (processedKeys.has(cacheKey)) continue;
        processedKeys.add(cacheKey);

        // Use cache if possible
        if (shouldUseCache(cacheKey)) {
            // Add icon from cache
            if (request.entry) {
                const content = typeof commentCache[cacheKey] === 'object' ?
                    commentCache[cacheKey].content : commentCache[cacheKey];
                const hasComment = content && content !== "__has_comment__" && content.trim() !== '';

                if (hasComment) {
                    addCommentIcon(request.entry, request.username, request.mediaId, hasComment, content);
                }
            }
            continue;
        }

        // Keep in queue
        optimizedQueue.push(request);
    }

    // Update queue
    pendingRequests = optimizedQueue;

    if (DEBUG) {
        console.log(`Queue optimized: ${pendingRequests.length} requests after removing duplicates and using cache`);
    }
}

// Check if cache should be used
function shouldUseCache(cacheKey) {
    if (!commentCache[cacheKey]) return false;

    const now = Date.now();

    if (typeof commentCache[cacheKey] === 'object' &&
        commentCache[cacheKey].timestamp) {

        const cacheAge = now - commentCache[cacheKey].timestamp;
        const isFresh = cacheAge < (CACHE_MAX_AGE * 0.75);

        // Use cache more for large queues
        if (pendingRequests.length > 15) {
            return isFresh || cacheAge < CACHE_MAX_AGE;
        }

        return isFresh;
    }

    return false;
}

// Process next batch of requests
async function processNextBatch() {
    // Check context
    if (!isExtensionContextValid()) {
        processingRequests = false;
        return;
    }

    if (pendingRequests.length === 0 || isRateLimited) {
        processingRequests = false;
        return;
    }

    // Rate limiting check
    const now = Date.now();

    // Reset counter if needed
    if (now - lastMinuteReset > 60000) {
        requestsInLastMinute = 0;
        lastMinuteReset = now;
    }

    // Check available slots
    const availableSlots = MAX_REQUESTS_PER_MINUTE - requestsInLastMinute;

    // Cool down if near limit
    if (availableSlots <= 2) {
        if (DEBUG) console.log("Approaching rate limit, cooling down...");
        setTimeout(() => {
            processNextBatch();
        }, 10000);
        return;
    }

    // Get batch size
    const batchSize = Math.min(availableSlots - 1, BATCH_SIZE, pendingRequests.length);

    if (DEBUG) console.log(`Processing batch of ${batchSize} requests, ${pendingRequests.length - batchSize} remaining in queue`);

    // Get batch
    const batch = pendingRequests.splice(0, batchSize);

    // Update tracking
    requestsInLastMinute += batchSize;
    activeBatchCount++;

    // Process batch
    const batchPromises = batch.map((request, index) => {
        // Spread requests
        const spreadDelay = index * MIN_BATCH_SPREAD;

        return new Promise(async (resolve) => {
            // Add delay
            if (spreadDelay > 0) {
                await new Promise(r => setTimeout(r, spreadDelay));
            }

            try {
                // Process request
                if (request.type === 'checkComment') {
                    // Fetch comment
                    const comment = await fetchUserComment(request.username, request.mediaId);

                    // Update cache
                    const cacheKey = `${request.username}-${request.mediaId}`;
                    const hasComment = comment && comment.trim() !== '';

                    commentCache[cacheKey] = {
                        content: comment || '',
                        timestamp: Date.now()
                    };

                    // Add icon if needed
                    if (request.entry && hasComment) {
                        addCommentIcon(request.entry, request.username, request.mediaId, hasComment, comment);
                    }
                }

                resolve();
            } catch (error) {
                console.error(`Error processing request for ${request.username}:`, error);

                // Handle rate limiting
                if (error.message && (
                    error.message.includes('429') ||
                    error.message.includes('rate limit') ||
                    error.message.includes('too many requests')
                )) {
                    isRateLimited = true;
                    rateLimitResetTime = Date.now() + 300000; // 5 minutes

                    // Add warning
                    const followingSection = document.querySelector('div[class="following"]');
                    if (followingSection && !document.querySelector('.rate-limit-warning')) {
                        addRateLimitWarning(followingSection);
                    }
                }

                resolve(); // Continue batch
            }
        });
    });

    // Wait for batch to complete
    await Promise.all(batchPromises);

    // Save cache periodically
    if (Object.keys(commentCache).length % 10 === 0) {
        saveCache();
    }

    // Update batch count
    activeBatchCount--;

    // Schedule next batch
    if (pendingRequests.length > 0 && !isRateLimited) {
        setTimeout(() => {
            processNextBatch();
        }, BATCH_COOLDOWN);
    } else {
        processingRequests = activeBatchCount > 0;
    }
}

// Save cache
function saveCache() {
    // Context check
    if (!isExtensionContextValid()) {
        console.log("Extension context invalidated, can't save cache");
        return;
    }

    // Check size
    if (Object.keys(commentCache).length > MAX_CACHE_ENTRIES) {
        trimCache();
    }

    try {
        // Add a lastUpdated timestamp for synchronization
        const cacheData = {
            commentCache,
            // Save mediaUserMap
            mediaUserMap: Object.fromEntries(
                Object.entries(mediaUserMap).map(([mediaId, userSet]) =>
                    [mediaId, Array.from(userSet)]
                )
            ),
            // Add last update time for sync between tabs
            lastUpdated: Date.now()
        };

        chrome.storage.local.set(cacheData, function() {
            if (chrome.runtime.lastError) {
                console.error("Error saving cache:", chrome.runtime.lastError);
            } else if (DEBUG) {
                console.log(`Comment cache saved with ${Object.keys(commentCache).length} items`);
            }
        });
    } catch (error) {
        console.error("Error saving to chrome.storage:", error);
    }
}

// Trim cache to maximum size
function trimCache() {
    // Convert to array
    const cacheEntries = Object.entries(commentCache);

    // Sort by timestamp (oldest first)
    cacheEntries.sort((a, b) => {
        const timeA = typeof a[1] === 'object' ? (a[1].timestamp || 0) : 0;
        const timeB = typeof b[1] === 'object' ? (b[1].timestamp || 0) : 0;
        return timeA - timeB;
    });

    // Calculate entries to remove
    const targetEntries = Math.floor(MAX_CACHE_ENTRIES * 0.8);
    let entriesToRemove = Math.max(0, cacheEntries.length - targetEntries);

    if (DEBUG) console.log(`Trimming cache: removing ${entriesToRemove} oldest entries`);

    // Create new cache
    const newCache = {};

    // Keep newer entries
    for (let i = entriesToRemove; i < cacheEntries.length; i++) {
        newCache[cacheEntries[i][0]] = cacheEntries[i][1];
    }

    commentCache = newCache;

    // Save
    saveCache();
}

// Calculate cache size
function getCacheSizeInBytes() {
    let size = 0;

    for (const [key, value] of Object.entries(commentCache)) {
        // Key size
        size += key.length * 2;

        if (typeof value === 'object') {
            // Content size
            if (value.content) {
                size += value.content.length * 2;
            }

            // Timestamp
            size += 8;

            // Object overhead
            size += 40;
        } else if (typeof value === 'string') {
            // String size
            size += value.length * 2;
        }
    }

    return size;
}

// Check cache size
function checkCacheSize() {
    const sizeInBytes = getCacheSizeInBytes();
    const numEntries = Object.keys(commentCache).length;

    if (DEBUG) {
        console.log(`Cache status: ${numEntries} entries, approximately ${Math.round(sizeInBytes / 1024)}KB`);
    }

    // Trim if needed
    if (sizeInBytes > MAX_CACHE_SIZE_BYTES || numEntries > MAX_CACHE_ENTRIES) {
        trimCache();
    }
}

// Clean expired cache
function cleanupExpiredCache() {
    if (DEBUG) console.log("Running scheduled cache cleanup");

    const now = Date.now();
    const validEntries = {};
    let expiredCount = 0;

    // Check all entries
    for (const [key, value] of Object.entries(commentCache)) {
        const isValid = typeof value === 'object' &&
            value.timestamp &&
            (now - value.timestamp) < CACHE_MAX_AGE;

        if (isValid) {
            validEntries[key] = value;

            // Update media-user map
            const keyParts = key.split('-');
            if (keyParts.length >= 2) {
                const username = keyParts[0];
                const mediaId = parseInt(keyParts[1]);

                if (!isNaN(mediaId)) {
                    if (!mediaUserMap[mediaId]) {
                        mediaUserMap[mediaId] = new Set();
                    }
                    mediaUserMap[mediaId].add(username);
                }
            }
        } else {
            expiredCount++;
        }
    }

    // Update cache if needed
    if (expiredCount > 0) {
        if (DEBUG) console.log(`Removed ${expiredCount} expired cache entries during scheduled cleanup`);
        commentCache = validEntries;
        saveCache();
    }

    // Check size
    checkCacheSize();
}

// Start cache cleanup timer
function startCacheCleanupTimer() {
    if (!isExtensionContextValid()) return;

    if (cacheCleanupTimer) {
        clearInterval(cacheCleanupTimer);
    }

    cacheCleanupTimer = setInterval(function() {
        if (isExtensionContextValid()) {
            cleanupExpiredCache();
        } else {
            clearInterval(cacheCleanupTimer);
            cacheCleanupTimer = null;
        }
    }, CACHE_CLEANUP_INTERVAL);
}

// Check if comment is in cache
function hasCachedComment(cacheKey) {
    if (!commentCache[cacheKey]) return false;

    // New cache format
    if (typeof commentCache[cacheKey] === 'object') {
        const content = commentCache[cacheKey].content;
        if (!content || content.trim() === '') return false;

        // Check expiration
        const now = Date.now();
        if (commentCache[cacheKey].timestamp) {
            const isExpired = (now - commentCache[cacheKey].timestamp) >= CACHE_MAX_AGE;
            return !isExpired;
        }

        return true;
    }
    // Legacy format
    else if (typeof commentCache[cacheKey] === 'string') {
        if (commentCache[cacheKey] === "__has_comment__") {
            return true;
        }
        return commentCache[cacheKey] && commentCache[cacheKey].trim() !== '';
    }

    return false;
}

// Get comment from cache
function getCachedComment(cacheKey, validateMedia = true) {
    if (!commentCache[cacheKey]) return '';

    // Extract username and mediaId for validation
    if (validateMedia) {
        const keyParts = cacheKey.split('-');
        if (keyParts.length >= 2) {
            const username = keyParts[0];
            const mediaId = parseInt(keyParts[1]);

            // Current media info
            const currentMediaInfo = extractMediaIdFromUrl();
            const currentMediaId = currentMediaInfo ? currentMediaInfo.id : null;

            // Only validate if obvious mismatch
            if (currentMediaId && mediaId &&
                currentMediaId !== mediaId &&
                Math.abs(currentMediaId - mediaId) > 10000) {
                console.warn(`Media ID mismatch in getCachedComment: ${mediaId} vs ${currentMediaId}`);
                // Still return content with warning
            }
        }
    }

    // New cache format
    if (typeof commentCache[cacheKey] === 'object') {
        if (commentCache[cacheKey] && 'content' in commentCache[cacheKey]) {
            return commentCache[cacheKey].content || '';
        }
        return '';
    }
    // Legacy format
    else if (typeof commentCache[cacheKey] === 'string') {
        if (commentCache[cacheKey] === "__has_comment__") {
            return '';
        }
        return commentCache[cacheKey] || '';
    }

    return '';
}

// Fetch comment from API
async function fetchUserComment(username, mediaId) {
    const isCurrentUser = (username === currentUsername);

    if (FORCE_DEBUG) {
        console.log(`Fetch request for ${username} on media ${mediaId} (current user: ${isCurrentUser})`);
    }

    // Check current page media ID
    const currentMediaInfo = extractMediaIdFromUrl();
    const currentMediaId = currentMediaInfo ? currentMediaInfo.id : null;

    // Use cache when rate limited
    const cacheKey = `${username}-${mediaId}`;
    if (isRateLimited && commentCache[cacheKey]) {
        if (FORCE_DEBUG) {
            console.log(`Using cached content due to rate limiting for ${username}`);
        }
        return typeof commentCache[cacheKey] === 'object' ?
            commentCache[cacheKey].content : commentCache[cacheKey];
    }

    // Query for comment
    const query = `
        query ($userName: String, $mediaId: Int) {
            MediaList(userName: $userName, mediaId: $mediaId) {
                notes
                status
                score
            }
        }
    `;

    const variables = { userName: username, mediaId };

    // Use retry with backoff
    let retryCount = 0;
    let delay = RETRY_DELAY_BASE;

    while (retryCount <= MAX_RETRIES) {
        try {
            // Verify media ID again
            const currentPageMedia = extractMediaIdFromUrl();
            const currentPageId = currentPageMedia ? currentPageMedia.id : null;

            // Only warn about extreme mismatches
            if (currentPageId && mediaId &&
                currentPageId !== mediaId &&
                Math.abs(currentPageId - mediaId) > 10000) {
                console.warn(`Warning: Fetching comment for media ${mediaId} but current page is ${currentPageId}`);
                // Continue anyway for backward compatibility
            }

            // Add small delay
            await new Promise(resolve => setTimeout(resolve, Math.random() * 200));

            // Make request
            const response = await fetch("https://graphql.anilist.co", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                body: JSON.stringify({ query, variables })
            });

            // Handle HTTP errors
            if (!response.ok) {
                const status = response.status;

                // Handle rate limiting
                if (status === 429) {
                    isRateLimited = true;
                    rateLimitResetTime = Date.now() + 300000;
                    throw new Error("Rate limit exceeded (HTTP 429)");
                }

                throw new Error(`HTTP error ${status}`);
            }

            const data = await response.json();

            // Check for errors
            if (data.errors) {
                if (data.errors.some(e => e.message && e.message.toLowerCase().includes('rate'))) {
                    isRateLimited = true;
                    rateLimitResetTime = Date.now() + 300000;
                    throw new Error("Rate limit exceeded in response");
                }
                throw new Error(data.errors[0].message || "Unknown GraphQL error");
            }

            // Extract notes
            if (data.data && data.data.MediaList) {
                return data.data.MediaList.notes || "";
            }

            return "";
        } catch (error) {
            const currentAttempt = retryCount + 1;
            console.error(`API request error (attempt ${currentAttempt}/${MAX_RETRIES + 1}):`, error);

            // Check for rate limiting
            const isSevereError = error.message && (
                error.message.includes('429') ||
                error.message.includes('rate limit') ||
                error.message.includes('too many requests')
            );

            if (isSevereError) {
                isRateLimited = true;
                rateLimitResetTime = Date.now() + 300000;

                // Add UI warning
                setTimeout(() => {
                    const followingSection = document.querySelector('div[class="following"]');
                    if (followingSection && !document.querySelector('.rate-limit-warning')) {
                        addRateLimitWarning(followingSection);
                    }
                }, 100);

                return "Rate limit reached. Try again later.";
            }

            retryCount++;

            if (retryCount <= MAX_RETRIES) {
                // Use longer delay for server errors
                const serverError = error.message && error.message.includes('500');
                const waitTime = serverError ? delay * 2 : delay;

                await new Promise(resolve => setTimeout(resolve, waitTime));
                delay *= RETRY_DELAY_FACTOR;
            } else {
                return "";
            }
        }
    }
}

// Core initialization
function initializeExtension() {
    // Check if on media page
    const mediaInfo = extractMediaIdFromUrl();
    isAnimePage = !!mediaInfo;

    if (!isAnimePage) {
        if (DEBUG) console.log("Not on a valid media page, extension not initialized");
        return;
    }

    if (isInitialized) {
        if (DEBUG) console.log("Extension already initialized, ignoring");
        return;
    }

    const mediaId = mediaInfo.id;
    const mediaType = mediaInfo.type;

    if (DEBUG) console.log(`Initializing extension on ${mediaType.toLowerCase()} page ID:`, mediaId);

    // Reset any previous state
    resetInitialization();

    // Start detection
    startPersistentDetection(mediaId);

    // Add scroll listener
    window.addEventListener('scroll', debounce(() => {
        if (!isInitialized && isAnimePage) {
            checkForFollowingSection(mediaId);
        }
    }, 500));
}

function resetExtensionState() {
    // Reset all flags
    isInitialized = false;
    isRateLimited = false;
    rateLimitResetTime = null;
    pendingRequests = [];
    processingRequests = false;

    // Stop detection systems
    stopDetection();

    // Clear any existing tooltips
    try {
        const tooltip = document.getElementById("anilist-tooltip");
        if (tooltip) tooltip.remove();

        const tooltipManager = TooltipManager.getInstance();
        tooltipManager.forceHide();

        // Also clear any notifications
        const notification = document.getElementById("anilist-hover-notification");
        if (notification) notification.style.display = "none";
    } catch (e) {
        console.error("Error clearing UI elements:", e);
    }

    if (DEBUG) console.log("Extension state completely reset");
}

// Reset initialization
function resetInitialization() {
    isInitialized = false;
    stopDetection();

    // Reset flags
    isRateLimited = false;
    rateLimitResetTime = null;
}

// Load cache and initialize
function loadCacheAndInitialize() {
    if (!isExtensionContextValid()) return;

    try {
        // Richiedere TUTTI i campi rilevanti dalla storage
        chrome.storage.local.get(null, function(result) {
            if (!isExtensionContextValid()) return;

            // Caricamento commentCache
            if (result.commentCache) {
                if (DEBUG) console.log("Comment cache loaded from storage:", Object.keys(result.commentCache).length, "items");

                // Elaborazione della cache come prima
                const now = Date.now();
                const validEntries = {};
                let expiredCount = 0;

                for (const [key, value] of Object.entries(result.commentCache)) {
                    if (typeof value === 'object' && value.timestamp && (now - value.timestamp) < CACHE_MAX_AGE) {
                        validEntries[key] = value;
                    } else if (typeof value === 'string' && value !== "__has_comment__") {
                        // Migrazione formato vecchio
                        validEntries[key] = {
                            content: value,
                            timestamp: now
                        };
                    } else {
                        expiredCount++;
                    }
                }

                commentCache = validEntries;

                if (expiredCount > 0 && DEBUG) {
                    console.log(`Removed ${expiredCount} expired cache entries`);
                    if (isExtensionContextValid()) {
                        chrome.storage.local.set({commentCache: validEntries});
                    }
                }
            }

            // Ripristino mediaUserMap
            if (result.mediaUserMap) {
                try {
                    mediaUserMap = {};
                    for (const [mediaId, users] of Object.entries(result.mediaUserMap)) {
                        mediaUserMap[mediaId] = new Set(users);
                    }

                    if (DEBUG) {
                        console.log(`Restored media-user map with ${Object.keys(mediaUserMap).length} media entries`);
                    }
                } catch (e) {
                    console.error("Error restoring media-user map:", e);
                    mediaUserMap = {};
                }
            } else {
                mediaUserMap = {};
                rebuildMediaUserMap();
            }

            // Avviare timer pulizia cache
            startCacheCleanupTimer();

            // Inizializzare estensione
            initializeExtension();
        });
    } catch (e) {
        console.error("Error loading cache:", e);
        commentCache = {};
        mediaUserMap = {};
        initializeExtension();
    }
}

// Funzione che aggiorna le icone di commento basate sulla cache attuale
function refreshCommentIcons() {
    const currentMediaInfo = extractMediaIdFromUrl();
    const currentMediaId = currentMediaInfo ? currentMediaInfo.id : null;

    if (!currentMediaId || !isInitialized) return;

    if (DEBUG) console.log("Refreshing comment icons based on updated cache");

    // Trova tutte le icone di commento attuali e le rimuove
    const followingSection = document.querySelector('div[class="following"]') ||
        document.querySelector('div.following') ||
        document.querySelector('[class^="following"]') ||
        document.querySelector('[class*=" following"]');

    if (!followingSection) return;

    // Trova tutti gli user entry
    const userEntrySelectors = [
        'a[class="follow"]',
        'a.follow',
        'a[class^="follow"]',
        'a.user',
        'a[class*="user"]',
        'a:has(div[class="name"])'
    ];

    let userEntries = [];

    // Trova user entries
    for (const selector of userEntrySelectors) {
        try {
            const entries = followingSection.querySelectorAll(selector);
            if (entries.length > 0) {
                userEntries = [...userEntries, ...Array.from(entries)];
            }
        } catch (e) {
            // Alcuni selettori potrebbero non essere supportati
        }
    }

    // Rimuovi eventuali duplicati
    const uniqueEntries = [];
    const seenElements = new Set();

    for (const entry of userEntries) {
        const entryId = entry.textContent?.trim() || entry.innerHTML;
        if (!seenElements.has(entryId)) {
            seenElements.add(entryId);
            uniqueEntries.push(entry);
        }
    }

    userEntries = uniqueEntries;

    if (userEntries.length === 0) return;

    // Per ogni entry
    for (const entry of userEntries) {
        // Rimuovi icona esistente
        const existingIcon = entry.querySelector(".comment-icon-column");
        if (existingIcon) existingIcon.remove();

        // Prendi nome utente
        const nameElement = entry.querySelector("div[class='name']");
        if (!nameElement) continue;

        const username = nameElement.textContent.trim();
        const cacheKey = `${username}-${currentMediaId}`;

        // Controlla cache
        if (commentCache[cacheKey]) {
            const hasComment = hasCachedComment(cacheKey);
            const commentContent = getCachedComment(cacheKey, false);

            // Aggiungi icona se c'è un commento
            if (hasComment) {
                addCommentIcon(entry, username, currentMediaId, true, commentContent);
            }
        }
    }

    if (DEBUG) console.log("Comment icons refreshed successfully");
}

// Migliora il listener per i cambiamenti nello storage
chrome.storage.onChanged.addListener(function(changes, namespace) {
    if (namespace === 'local' && changes.commentCache) {
        // Aggiorna la cache in memoria con i nuovi valori
        const newCache = changes.commentCache.newValue || {};

        // Aggiorna tutta la cache
        commentCache = newCache;

        if (DEBUG) console.log("Cache updated from another tab");

        // Aggiorna le icone di commento
        refreshCommentIcons();

        // Aggiorna anche eventuali tooltip aperti
        const tooltip = document.getElementById("anilist-tooltip");
        if (tooltip && tooltip.style.display === 'block') {
            const username = tooltip.getAttribute('data-username');
            const mediaId = parseInt(tooltip.getAttribute('data-media-id'));

            if (username && mediaId) {
                const cacheKey = `${username}-${mediaId}`;
                if (commentCache[cacheKey]) {
                    const commentContent = getCachedComment(cacheKey, false);
                    window.updateTooltipContent(tooltip, commentContent, username, mediaId);
                }
            }
        }
    }
});

// Rebuild media-user map from cache
function rebuildMediaUserMap() {
    mediaUserMap = {};
    let entriesProcessed = 0;

    for (const key of Object.keys(commentCache)) {
        const keyParts = key.split('-');
        if (keyParts.length >= 2) {
            const username = keyParts[0];
            const mediaId = parseInt(keyParts[1]);

            if (!isNaN(mediaId)) {
                if (!mediaUserMap[mediaId]) {
                    mediaUserMap[mediaId] = new Set();
                }
                mediaUserMap[mediaId].add(username);
                entriesProcessed++;
            }
        }
    }

    if (DEBUG) {
        console.log(`Rebuilt media-user map with ${Object.keys(mediaUserMap).length} media entries from ${entriesProcessed} cache entries`);
    }
}

// Tooltip manager (singleton)
const TooltipManager = (function() {
    let instance;
    let tooltip = null;
    let currentElement = null;
    let currentUsername = null;
    let currentMediaId = null;
    let isLoading = false;
    let showTimer = null;
    let hideTimer = null;
    let isTransitioning = false;
    let lastMouseEvent = null;

    // Constants
    const SHOW_DELAY = 150;
    const HIDE_DELAY = 300;
    const TRANSITION_BUFFER = 150;

    // Get or create tooltip element
    function getTooltip() {
        if (!tooltip) {
            tooltip = document.getElementById("anilist-tooltip");
            if (!tooltip) {
                tooltip = document.createElement("div");
                tooltip.id = "anilist-tooltip";
                document.body.appendChild(tooltip);

                tooltip.addEventListener("mouseenter", function() {
                    if (hideTimer) {
                        clearTimeout(hideTimer);
                        hideTimer = null;
                    }
                });

                tooltip.addEventListener("mouseleave", function() {
                    startHideTooltip();
                });
            }
        }
        return tooltip;
    }

    // Position tooltip in right column with fixed vertical position
    function positionTooltip(element) {
        const tooltip = getTooltip();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Make visible for size calculation
        const wasHidden = tooltip.style.display === 'none';
        if (wasHidden) {
            tooltip.style.opacity = '0';
            tooltip.style.display = 'block';
        }

        // Get dimensions
        const tooltipWidth = tooltip.offsetWidth;
        const tooltipHeight = tooltip.offsetHeight;

        // Find the Following section - our main reference point
        const followingSection = document.querySelector('div[class="following"], div.following');

        if (!followingSection) {
            // Fallback if Following section not found
            const defaultX = viewportWidth - 320 - 20;
            const defaultY = window.scrollY + 100;

            tooltip.style.left = defaultX + 'px';
            tooltip.style.top = defaultY + 'px';

            if (wasHidden) {
                setTimeout(() => { tooltip.style.opacity = '1'; }, 50);
            }
            return;
        }

        // Get Following section dimensions and position
        const followingRect = followingSection.getBoundingClientRect();

        // HORIZONTAL POSITIONING:
        // Position in the right column, with margins on both sides
        // Calculate available space and center tooltip with margins
        const rightMargin = 20; // Equal margin on the right side
        const availableWidth = viewportWidth - (followingRect.right + 20) - rightMargin;

        // If space is tight, prioritize the left margin (near Following section)
        const posX = availableWidth >= tooltipWidth
            ? followingRect.right + 20 + window.scrollX
            : viewportWidth - tooltipWidth - rightMargin + window.scrollX;

        // VERTICAL POSITIONING:
        // Align exactly with the top of the Following section for perfect alignment
        let posY = followingRect.top + window.scrollY;

        // No additional offset - exact alignment with Following section

        // Check if we need to adjust due to viewport constraints
        if (posY + tooltipHeight > window.scrollY + viewportHeight - 20) {
            // If tooltip would extend beyond bottom of viewport, adjust upward
            posY = window.scrollY + viewportHeight - tooltipHeight - 20;
        }

        // Check if tooltip would be cut off at the top
        if (posY < window.scrollY + 10) {
            posY = window.scrollY + 10;
        }

        // Get the hovered element (comment icon) for highlighting
        const hoveredElement = element.querySelector('.anilist-comment-icon') || element;
        const hoveredRect = hoveredElement.getBoundingClientRect();

        // Store the element we're currently displaying comment for
        tooltip.setAttribute('data-current-element',
            hoveredElement.closest('a')?.querySelector('.name')?.textContent || '');

        // Add highlight effect to the active comment
        const allIcons = document.querySelectorAll('.anilist-comment-icon');
        allIcons.forEach(icon => icon.classList.remove('active-comment'));
        hoveredElement.classList.add('active-comment');

        // Set position with smooth transition
        tooltip.style.transition = "left 0.2s ease, top 0.2s ease";
        tooltip.style.left = posX + 'px';
        tooltip.style.top = posY + 'px';

        // Restore visibility
        if (wasHidden) {
            setTimeout(() => {
                tooltip.style.opacity = '1';
            }, 50);
        }
    }

    // Start showing tooltip
    function startShowTooltip(element, username, mediaId) {
        // Cancel hide timer
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }

        // Already showing for this element
        if (currentElement === element && tooltip && tooltip.style.display === 'block') {
            return;
        }

        // Transition between elements
        if (currentElement && currentElement !== element && tooltip && tooltip.style.display === 'block') {
            isTransitioning = true;

            if (showTimer) {
                clearTimeout(showTimer);
            }

            currentElement = element;
            currentUsername = username;
            currentMediaId = mediaId;

            positionTooltip(element);
            updateTooltipContent("Loading...");
            loadComment(username, mediaId);
            return;
        }

        // Start show timer
        if (!showTimer) {
            showTimer = setTimeout(() => {
                currentElement = element;
                currentUsername = username;
                currentMediaId = mediaId;

                const tooltip = getTooltip();
                tooltip.style.display = 'block';

                positionTooltip(element);
                updateTooltipContent("Loading...");
                loadComment(username, mediaId);

                showTimer = null;
                isTransitioning = false;
            }, SHOW_DELAY);
        }
    }

    // Start hiding tooltip
    function startHideTooltip() {
        if (isTransitioning) {
            setTimeout(() => {
                isTransitioning = false;
            }, TRANSITION_BUFFER);
            return;
        }

        if (showTimer) {
            clearTimeout(showTimer);
            showTimer = null;
        }

        if (!hideTimer && tooltip && tooltip.style.display === 'block') {
            hideTimer = setTimeout(() => {
                hideTooltip();
                hideTimer = null;
            }, HIDE_DELAY);
        }
    }

    // Hide tooltip immediately
    function hideTooltip() {
        if (tooltip) {
            tooltip.style.display = 'none';
        }
        currentElement = null;
        isTransitioning = false;
    }

    // Update tooltip content
    function updateTooltipContent(content) {
        const tooltip = getTooltip();

        if (content === "Loading...") {
            tooltip.innerHTML = "<div class='tooltip-loading'>Loading...</div>";
            return;
        }

        // Use external function
        if (window.updateTooltipContent && typeof window.updateTooltipContent === 'function') {
            window.updateTooltipContent(tooltip, content, currentUsername, currentMediaId);
        } else {
            // Fallback
            tooltip.textContent = "";

            if (content && content.trim() !== "") {
                const commentDiv = document.createElement("div");
                commentDiv.className = "comment";
                commentDiv.textContent = content;
                tooltip.appendChild(commentDiv);
            } else {
                const noCommentDiv = document.createElement("div");
                noCommentDiv.className = "no-comment";
                noCommentDiv.textContent = "No comment";
                tooltip.appendChild(noCommentDiv);
            }
        }
    }

    // Load comment from cache or API
    async function loadComment(username, mediaId) {
        isLoading = true;

        // Cache key
        const cacheKey = `${username}-${mediaId}`;

        // Try cache first
        let comment = null;
        let cacheIsValid = false;
        const now = Date.now();

        if (commentCache[cacheKey]) {
            if (typeof commentCache[cacheKey] === 'object' && commentCache[cacheKey].content) {
                comment = commentCache[cacheKey].content;

                // Check if still valid
                if (commentCache[cacheKey].timestamp &&
                    (now - commentCache[cacheKey].timestamp) < CACHE_MAX_AGE) {
                    cacheIsValid = true;
                }
            } else if (typeof commentCache[cacheKey] === 'string' &&
                commentCache[cacheKey] !== "__has_comment__") {
                comment = commentCache[cacheKey];
            }

            // Show cached content
            if (comment) {
                updateTooltipContent(comment);

                // Skip API if valid or rate limited
                if (cacheIsValid || isRateLimited) {
                    isLoading = false;
                    return;
                }
            }
        }

        // Otherwise load from API
        if (!cacheIsValid && !isRateLimited) {
            try {
                // Update rate tracking
                const now = Date.now();
                if (now - lastMinuteReset > 60000) {
                    requestsInLastMinute = 1;
                    lastMinuteReset = now;
                } else {
                    requestsInLastMinute++;
                }

                // Check rate limit
                if (requestsInLastMinute <= MAX_REQUESTS_PER_MINUTE) {
                    comment = await fetchUserComment(username, mediaId);

                    // Update cache
                    commentCache[cacheKey] = {
                        content: comment || '',
                        timestamp: Date.now()
                    };

                    saveCache();

                    // Update if still current
                    if (currentUsername === username && currentMediaId === mediaId) {
                        updateTooltipContent(comment);
                    }
                } else {
                    // Rate limited
                    updateTooltipContent("Rate limit reached. Try again later.");
                    isRateLimited = true;

                    setTimeout(() => {
                        isRateLimited = false;
                        requestsInLastMinute = 0;
                    }, 60000);
                }
            } catch (error) {
                // Error loading
                if (currentUsername === username && currentMediaId === mediaId) {
                    updateTooltipContent("Error loading comment");
                }
                console.error("API request error:", error);
            }
        } else {
            // Already rate limited
            updateTooltipContent("API rate limit reached. Try again later.");
        }

        isLoading = false;
    }

    // Check if point is near rect
    function isNear(point, rect, tolerance) {
        return (
            point.x >= rect.left - tolerance &&
            point.x <= rect.right + tolerance &&
            point.y >= rect.top - tolerance &&
            point.y <= rect.bottom + tolerance
        );
    }

    // Check if point is in path between points
    function isInPath(px, py, x1, y1, x2, y2, width) {
        // Calculate distance to line
        const A = px - x1;
        const B = py - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const len_sq = C * C + D * D;

        // Parameter on line
        let param = -1;
        if (len_sq != 0) param = dot / len_sq;

        let xx, yy;

        // Find closest point
        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }

        // Calculate distance
        const dx = px - xx;
        const dy = py - yy;
        const distance = Math.sqrt(dx * dx + dy * dy);

        return distance < width;
    }

    // Mouse move handler
    function handleMouseMove(e) {
        // Save event
        lastMouseEvent = { x: e.clientX, y: e.clientY };

        // Skip if no active tooltip
        if (!tooltip || tooltip.style.display !== 'block' || !currentElement) {
            return;
        }

        const elementRect = currentElement.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();

        // Tolerance
        const tolerance = 25;

        // Check proximity
        const isNearElement = isNear(
            { x: e.clientX, y: e.clientY },
            elementRect,
            tolerance
        );

        const isNearTooltip = isNear(
            { x: e.clientX, y: e.clientY },
            tooltipRect,
            tolerance
        );

        // Check corridor
        const isInCorridor = isInPath(
            e.clientX, e.clientY,
            (elementRect.left + elementRect.right) / 2,
            (elementRect.top + elementRect.bottom) / 2,
            (tooltipRect.left + tooltipRect.right) / 2,
            (tooltipRect.top + tooltipRect.bottom) / 2,
            tolerance * 2.5
        );

        // Check other icons
        const isNearAnotherIcon = isNearAnyCommentIcon(e.clientX, e.clientY);

        // Keep visible in safe area
        if (isNearElement || isNearTooltip || isInCorridor || isNearAnotherIcon) {
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }

            // Set transition
            if (isNearAnotherIcon && !isNearElement && !isNearTooltip) {
                isTransitioning = true;
            }
        } else {
            // Start hiding
            startHideTooltip();
        }
    }

    // Check if near any comment icon
    function isNearAnyCommentIcon(x, y) {
        if (!currentElement) return false;

        const tolerance = 35;
        const icons = document.querySelectorAll(".anilist-comment-icon");

        for (const icon of icons) {
            // Skip current
            if (icon.closest(".comment-icon-column") === currentElement) continue;

            const rect = icon.getBoundingClientRect();
            if (
                x >= rect.left - tolerance &&
                x <= rect.right + tolerance &&
                y >= rect.top - tolerance &&
                y <= rect.bottom + tolerance
            ) {
                return true;
            }
        }

        return false;
    }

    // Initialize
    function init() {
        // Add global mouse listener
        document.addEventListener("mousemove", handleMouseMove);

        return {
            // Show tooltip
            show: function(element, username, mediaId) {
                startShowTooltip(element, username, mediaId);
            },

            // Start hiding
            hide: function() {
                startHideTooltip();
            },

            // Force hide
            forceHide: function() {
                hideTooltip();
            },

            // Refresh content
            refreshContent: async function() {
                if (!currentUsername || !currentMediaId) return;

                updateTooltipContent("Loading...");

                try {
                    const comment = await fetchUserComment(currentUsername, currentMediaId);

                    // Update cache
                    const cacheKey = `${currentUsername}-${currentMediaId}`;
                    commentCache[cacheKey] = {
                        content: comment || '',
                        timestamp: Date.now()
                    };

                    saveCache();
                    updateTooltipContent(comment);
                } catch (error) {
                    console.error("Error refreshing tooltip content:", error);
                    updateTooltipContent("Error refreshing content");
                }
            },

            // Cleanup
            cleanup: function() {
                document.removeEventListener("mousemove", handleMouseMove);

                if (showTimer) {
                    clearTimeout(showTimer);
                    showTimer = null;
                }

                if (hideTimer) {
                    clearTimeout(hideTimer);
                    hideTimer = null;
                }

                if (tooltip) {
                    tooltip.remove();
                    tooltip = null;
                }

                currentElement = null;
                isTransitioning = false;
            }
        };
    }

    // Return singleton
    return {
        getInstance: function() {
            if (!instance) {
                instance = init();
            }
            return instance;
        }
    };
})();

// Setup hover listener
function setupHoverListener(element, username, mediaId, cachedComment = null) {
    const tooltipManager = TooltipManager.getInstance();

    // Add mouseenter event
    element.addEventListener("mouseenter", () => {
        tooltipManager.show(element, username, mediaId);
    });

    // Add mouseleave event
    element.addEventListener("mouseleave", () => {
        setTimeout(() => {
            tooltipManager.hide();
        }, 50);
    });

    // Return cleanup function
    return function cleanup() {
        element.removeEventListener("mouseenter", () => {
            tooltipManager.show(element, username, mediaId);
        });

        element.removeEventListener("mouseleave", () => {
            setTimeout(() => {
                tooltipManager.hide();
            }, 50);
        });
    };
}

// Handle unload
window.addEventListener("unload", () => {
    // Cancel pending actions
    pendingRequests = [];
    processingRequests = false;

    // Clear observers
    if (globalObserver) {
        globalObserver.disconnect();
    }

    if (urlObserver) {
        urlObserver.disconnect();
    }

    // Stop timer
    if (cacheCleanupTimer) {
        clearInterval(cacheCleanupTimer);
    }

    // Save one last time
    if (isExtensionContextValid() && Object.keys(commentCache).length > 0) {
        try {
            chrome.storage.local.set({ commentCache });
        } catch (error) {
            console.error("Error saving cache on unload:", error);
        }
    }
});

// Detect current username early
function detectCurrentUsername() {
    // Check avatar link
    const avatarLink = document.querySelector('a[href^="/user/"]');
    if (avatarLink) {
        const href = avatarLink.getAttribute('href');
        if (href && href.startsWith('/user/')) {
            currentUsername = href.replace('/user/', '');
            if (DEBUG) console.log(`Detected current user: ${currentUsername} (via avatar)`);
            return;
        }
    }

    // Try navigation links
    setTimeout(() => {
        if (!currentUsername) {
            const navLinks = document.querySelectorAll('nav a');
            for (const link of navLinks) {
                if (link.href && link.href.includes('/user/')) {
                    currentUsername = link.href.split('/user/')[1];
                    if (DEBUG) console.log(`Detected current user: ${currentUsername} (via nav)`);
                    return;
                }
            }

            if (DEBUG) console.log("Could not detect current username, some features may be limited");
        }
    }, 2000);
}

// Detect when an anime/manga is saved in order to apply a comment if it exists
// Create a MutationObserver to detect changes in the DOM
const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
        // We only care about added nodes (childList) or attribute changes (attributes)
        if (mutation.type === 'childList' || mutation.type === 'attributes') {
            // Try to find the "Save" button in the DOM
            const saveButton = document.querySelector('.save-btn');

            // Check if the button exists and ensure the event listener hasn't been added already
            if (saveButton && !saveButton.dataset.listenerAdded) {
                saveButton.dataset.listenerAdded = "true"; // Mark the button to prevent duplicate listeners

                // Add a click event listener to detect when the "Save" button is pressed
                saveButton.addEventListener('click', function(event) {
                    console.log('Anime save state confirmed:', this.textContent.trim());
                });
            }
        }
    });
});

// Select the target node where changes occur (body includes all elements)
const targetNode = document.body;

// Define observer configuration:
// - childList: Detects when elements are added or removed
// - subtree: Monitors all child elements (not just direct children)
// - attributes: Detects changes in attributes (useful for dynamic updates)
const config = { childList: true, subtree: true, attributes: true };

// Start observing the document
observer.observe(targetNode, config);


// INITIALIZATION
// Load font awesome
loadFontAwesome();

// Detect username
detectCurrentUsername();

// Setup URL observer
urlObserver = setupUrlObserver();

// Setup navigation listeners
setupNavigationListeners();

// DOMContentLoaded listener
document.addEventListener('DOMContentLoaded', () => {
    if (isExtensionContextValid()) {
        console.log("Content script loaded, starting extension");
        loadCacheAndInitialize();
    }
});

// Start immediately if already loaded
if (document.readyState !== 'loading') {
    if (isExtensionContextValid()) {
        loadCacheAndInitialize();
    }
}