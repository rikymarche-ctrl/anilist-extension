// Content script for Anilist Hover Comments
console.log("Content script successfully loaded!");

// Configuration constants for cache management
const DEBUG = false;
const FORCE_DEBUG = false; // Set to false in production

// Increased for better reliability on first page load
const MAX_WAIT_TIME = 60000; // 60 seconds maximum wait time for Following section

// Cache constants
const CACHE_MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours
const MAX_CACHE_SIZE_BYTES = 100 * 1024;
const MAX_CACHE_ENTRIES = 250;
const CACHE_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes

// API Request management
const MAX_REQUESTS_PER_MINUTE = 20;
const BATCH_SIZE = 4; // Process this many requests in parallel
const BATCH_COOLDOWN = 3000; // Wait between batches (ms)
const MIN_BATCH_SPREAD = 300; // Minimum ms between requests in a batch

// Retry configuration
const MAX_RETRIES = 3; // Increased retries
const RETRY_DELAY_BASE = 2000;
const RETRY_DELAY_FACTOR = 2; // Exponential backoff

// Global variables
let commentCache = {};
let mediaUserMap = {};
let cacheCleanupTimer = null;
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
let detectRetryCount = 0;
let periodicCheckTimer = null;
let failedInitializationAttempts = 0;

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

    if (periodicCheckTimer) {
        clearInterval(periodicCheckTimer);
        periodicCheckTimer = null;
    }
}

// Helper function to find user entries in following section
function findUserEntries(followingSection) {
    // Standard user entry selectors
    const userEntrySelectors = [
        'a[class="follow"]',
        'a.follow',
        'a[class^="follow"]',
        'a.user',
        'a[class*="user"]',
        'a:has(div[class="name"])',
        'a:has(.name)',
        '.users a',
        '.user a',
        'a.name-wrapper'
    ];

    let userEntries = [];

    // Find all entries matching any selector
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

    return uniqueEntries;
}

// Persistent detection system for the Following section
function startPersistentDetection(mediaId) {
    console.log("Starting persistent detection system...");
    detectRetryCount = 0;
    failedInitializationAttempts = 0;

    // 1. Try immediately
    checkForFollowingSection(mediaId);

    // 2. Create a global observer with improved configuration
    globalObserver = new MutationObserver((mutations) => {
        if (!isInitialized) {
            let shouldCheck = false;

            for (const mutation of mutations) {
                // Check added nodes
                if (mutation.addedNodes.length) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Added more selectors to catch all variations
                            if (node.querySelector &&
                                (node.classList?.contains('following') ||
                                    node.querySelector?.('div[class="following"]') ||
                                    node.querySelector?.('div.following') ||
                                    node.querySelector?.('[class^="following"]') ||
                                    node.querySelector?.('[class*=" following"]'))) {
                                shouldCheck = true;
                                break;
                            }
                        }
                    }
                }

                // Check modified targets
                if (mutation.target.nodeType === Node.ELEMENT_NODE &&
                    mutation.target.querySelector &&
                    (mutation.target.querySelector('div[class="following"]') ||
                        mutation.target.querySelector('div.following') ||
                        mutation.target.querySelector('[class^="following"]') ||
                        mutation.target.querySelector('[class*=" following"]'))) {
                    shouldCheck = true;
                }

                if (shouldCheck) break;
            }

            if (shouldCheck) {
                setTimeout(() => checkForFollowingSection(mediaId), 100);
            }
        }
    });

    // Observe DOM changes with enhanced configuration
    globalObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'display'],
        characterData: false
    });

    // 3. Start progressive polling with retry mechanism
    startProgressivePolling(mediaId);

    // 4. Set final timeout
    setTimeout(() => {
        if (!isInitialized) {
            if (DEBUG) console.log("Final check for Following section after timeout");
            checkForFollowingSection(mediaId, true); // Force check

            // If still not initialized, add failsafe mechanism
            if (!isInitialized) {
                scheduleRetryInitialization(mediaId);
            }
        }
    }, MAX_WAIT_TIME);

    // 5. Set up periodic check even after initialization
    setupPeriodicCheck(mediaId);
}

// Schedule retry for initialization
function scheduleRetryInitialization(mediaId) {
    if (failedInitializationAttempts >= 3) return;

    failedInitializationAttempts++;
    console.log(`Scheduling retry initialization attempt ${failedInitializationAttempts}`);

    setTimeout(() => {
        if (!isInitialized) {
            console.log("Retrying initialization...");
            isInitialized = false; // Ensure flag is reset
            detectRetryCount = 0;
            startPersistentDetection(mediaId);
        }
    }, 5000 * failedInitializationAttempts); // Increasing delay
}

// Set up periodic check
function setupPeriodicCheck(mediaId) {
    if (periodicCheckTimer) {
        clearInterval(periodicCheckTimer);
    }

    periodicCheckTimer = setInterval(() => {
        if (isExtensionContextValid()) {
            // Verify all user entries have comment icons
            verifyCommentIcons(mediaId);
        } else {
            clearInterval(periodicCheckTimer);
        }
    }, 5000); // Check every 5 seconds
}

// Verify all user entries have comment icons
function verifyCommentIcons(mediaId) {
    const followingSection = document.querySelector('div[class="following"], div.following, [class^="following"], [class*=" following"]');
    if (!followingSection) return;

    // Get user entries
    const userEntries = findUserEntries(followingSection);
    if (userEntries.length === 0) return;

    // Check if any entries are missing icons
    let missingIcons = false;
    for (const entry of userEntries) {
        const nameElement = entry.querySelector("div[class='name']");
        if (!nameElement) continue;

        const username = nameElement.textContent.trim();
        const cacheKey = `${username}-${mediaId}`;

        // If we have this user in cache and they have a comment
        if (commentCache[cacheKey] && hasCachedComment(cacheKey)) {
            // But icon is missing
            if (!entry.querySelector(".comment-icon-column")) {
                missingIcons = true;
                getCachedComment(cacheKey, false);
                addCommentIcon(entry, username, mediaId, true);
            }
        }
    }

    if (missingIcons && DEBUG) {
        console.log("Fixed missing comment icons during periodic check");
    }
}

// Progressive polling
function startProgressivePolling(mediaId) {
    if (isPollingActive) return;
    isPollingActive = true;

    // Modified intervals - more frequent initial checks, less frequent later
    const intervals = [500, 1000, 1500, 2000, 3000, 5000, 8000, 10000, 15000, 20000];
    let currentInterval = 0;

    function poll() {
        if (isInitialized) {
            isPollingActive = false;
            return;
        }

        if (currentInterval >= intervals.length) {
            // Continue polling at the longest interval
            setTimeout(() => {
                if (!isInitialized) {
                    // Try again with force check
                    checkForFollowingSection(mediaId, true);
                    poll(); // Continue polling
                }
            }, intervals[intervals.length - 1]);
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

    // Increment retry counter for tracking
    detectRetryCount++;
    if (DEBUG) console.log(`Checking for Following section (attempt ${detectRetryCount})`);

    // Try different selectors - expanded for better coverage
    const selectors = [
        'div[class="following"]',
        'div.following',
        '[class^="following"]',
        '[class*=" following"]',
        '.medialist div[class*="following"]',
        '.container div[class*="following"]'
    ];

    let followingSection = null;

    // Find the section
    for (const selector of selectors) {
        try {
            const element = document.querySelector(selector);
            if (element) {
                followingSection = element;
                break;
            }
        } catch (e) {
            // Some selectors might cause errors in certain browsers
        }
    }

    if (followingSection) {
        if (DEBUG) console.log(`Following section found on attempt ${detectRetryCount}, checking for user entries`);

        // Short delay to ensure entries are loaded
        setTimeout(() => {
            // Get user entries
            const userEntries = findUserEntries(followingSection);

            if (userEntries.length > 0) {
                if (DEBUG) console.log(`Following section found with ${userEntries.length} users on attempt ${detectRetryCount}`);
                setupFollowingSection(followingSection, userEntries, mediaId);
                stopDetection();
                return true;
            } else if (DEBUG) {
                // If section found but no entries, log this for debugging
                console.log(`Following section found but no user entries detected (attempt ${detectRetryCount})`);
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
                (async () => {
                    await checkCurrentUserComment(entry, username, mediaId);
                })();
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
            getCachedComment(cacheKey, false); // Disable validation

            if (hasComment) {
                if (DEBUG) console.log(`Adding comment icon for ${username} from cache`);
                addCommentIcon(entry, username, mediaId, true);

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
        addCommentIcon(entry, username, mediaId, true);
        saveCache();
    } else {
        if (DEBUG) console.log(`Current user has no comment for media ${mediaId}`);
    }
}

// Add comment icon - REFACTORED to use CSS classes
function addCommentIcon(entry, username, mediaId, hasComment) {
    // Only proceed if still in the DOM
    if (!entry || !entry.isConnected) {
        if (DEBUG) console.log(`Entry for ${username} is no longer in the DOM, skipping icon addition`);
        return;
    }

    // Check if icon already exists
    if (entry.querySelector(".comment-icon-column")) {
        if (DEBUG) console.log(`Icon already exists for ${username}, skipping`);
        return;
    }

    if (hasComment) {
        // Set position relative if needed
        if (window.getComputedStyle(entry).position === 'static') {
            entry.style.position = 'relative';
        }

        // Create the icon column
        const iconColumn = document.createElement("div");
        iconColumn.className = "comment-icon-column";

        // Position based on status element
        const statusElement = entry.querySelector("div[class='status']");
        if (statusElement) {
            const statusRect = statusElement.getBoundingClientRect();
            const entryRect = entry.getBoundingClientRect();
            iconColumn.style.right = `${entryRect.right - statusRect.right + 10}px`;
        } else {
            iconColumn.style.right = "60px";
        }

        // Create comment icon
        const commentIcon = document.createElement("i");
        commentIcon.className = "fa-solid fa-comment anilist-comment-icon";

        // Add to column
        iconColumn.appendChild(commentIcon);

        // Stop click propagation
        iconColumn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        // Add to entry
        entry.appendChild(iconColumn);

        // Set up hover listener
        setupHoverListener(iconColumn, username, mediaId);
    }
}

// Add rate limit warning - REFACTORED to use CSS classes
function addRateLimitWarning(followingSection) {
    const warningDiv = document.createElement('div');
    warningDiv.className = 'rate-limit-warning';

    let resetMessage = '';
    if (rateLimitResetTime) {
        const resetMinutes = Math.ceil((rateLimitResetTime - Date.now()) / 60000);
        resetMessage = ` Please try again in approximately ${resetMinutes} minute${resetMinutes !== 1 ? 's' : ''}.`;
    }

    warningDiv.textContent = `Anilist API rate limit reached. Some comments may not be visible.${resetMessage}`;

    // Insert before the following section
    followingSection.parentNode.insertBefore(warningDiv, followingSection);
}

// Create refresh handler function - NEW HELPER
function createRefreshHandler(refreshButton, username, mediaId, tooltip) {
    return async function handleRefresh() {
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
}

// Tooltip content update - REFACTORED to avoid inline styles
window.updateTooltipContent = function(tooltip, comment, username, mediaId) {
    tooltip.textContent = "";

    // Store username/mediaId as data attributes for updates
    tooltip.setAttribute('data-username', username);
    tooltip.setAttribute('data-media-id', mediaId);

    // Create container
    const contentContainer = document.createElement("div");
    contentContainer.className = "tooltip-content";

    // Basic media ID check
    const currentPath = window.location.pathname;
    const currentMediaMatch = currentPath.match(/\/(anime|manga)\/(\d+)/);
    const currentMediaId = currentMediaMatch ? parseInt(currentMediaMatch[2]) : null;

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

    // Add refresh handler
    refreshButton.addEventListener("click", createRefreshHandler(refreshButton, username, mediaId, tooltip));

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
async function startProcessingRequests() {
    if (processingRequests || pendingRequests.length === 0 || isRateLimited) return;

    // Optimize queue
    optimizeRequestQueue();

    if (pendingRequests.length === 0) return;

    processingRequests = true;
    await processNextBatch();
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
                    addCommentIcon(request.entry, request.username, request.mediaId, hasComment);
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
                        addCommentIcon(request.entry, request.username, request.mediaId, hasComment);
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

    // Keep newer entries
    commentCache = {};
    for (let i = entriesToRemove; i < cacheEntries.length; i++) {
        commentCache[cacheEntries[i][0]] = cacheEntries[i][1];
    }

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

            // Handle HTTP errors without throwing
            if (!response.ok) {
                const status = response.status;

                // Handle rate limiting
                if (status === 429) {
                    isRateLimited = true;
                    rateLimitResetTime = Date.now() + 300000;

                    // Add UI warning
                    setTimeout(() => {
                        const followingSection = document.querySelector('div[class="following"]');
                        if (followingSection && !document.querySelector('.rate-limit-warning')) {
                            addRateLimitWarning(followingSection);
                        }
                    }, 100);

                    // Cache empty result
                    commentCache[cacheKey] = "";

                    return "Rate limit reached. Try again later.";
                }

                // For other HTTP errors, continue with retry logic
                retryCount++;
                if (retryCount <= MAX_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= RETRY_DELAY_FACTOR;
                    continue;
                } else {
                    // Return empty after max retries
                    return "";
                }
            }

            const data = await response.json();

            // Check for errors without throwing
            if (data.errors) {
                if (data.errors.some(e => e.message && e.message.toLowerCase().includes('rate'))) {
                    isRateLimited = true;
                    rateLimitResetTime = Date.now() + 300000;

                    // Add UI warning
                    setTimeout(() => {
                        const followingSection = document.querySelector('div[class="following"]');
                        if (followingSection && !document.querySelector('.rate-limit-warning')) {
                            addRateLimitWarning(followingSection);
                        }
                    }, 100);

                    // Cache empty result
                    commentCache[cacheKey] = "";

                    return "Rate limit reached. Try again later.";
                }

                // For other GraphQL errors, continue with retry logic
                retryCount++;
                if (retryCount <= MAX_RETRIES) {
                    const errorMsg = data.errors[0].message || "Unknown GraphQL error";
                    console.error(`GraphQL error (attempt ${retryCount}/${MAX_RETRIES + 1}):`, errorMsg);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= RETRY_DELAY_FACTOR;
                    continue;
                } else {
                    // Return empty after max retries
                    return "";
                }
            }

            // Extract notes
            if (data.data && data.data.MediaList) {
                const notes = data.data.MediaList.notes || "";
                // Cache successful result
                commentCache[cacheKey] = notes;
                return notes;
            }

            // Cache empty result
            commentCache[cacheKey] = "";
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

                // Cache the result
                commentCache[cacheKey] = "Rate limit reached. Try again later.";
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
                // Cache empty result after max retries
                commentCache[cacheKey] = "";
                return "";
            }
        }
    }

    // This line should never be reached, but added for safety
    return "";
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
    detectRetryCount = 0;
    failedInitializationAttempts = 0;

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
        chrome.storage.local.get(null, function(result) {
            if (!isExtensionContextValid()) return;

            // Load comment cache
            if (result.commentCache) {
                if (DEBUG) console.log("Comment cache loaded from storage:", Object.keys(result.commentCache).length, "items");

                // Process the cache
                const now = Date.now();
                const validEntries = {};
                let expiredCount = 0;

                for (const [key, value] of Object.entries(result.commentCache)) {
                    if (typeof value === 'object' && value.timestamp && (now - value.timestamp) < CACHE_MAX_AGE) {
                        validEntries[key] = value;
                    } else if (typeof value === 'string' && value !== "__has_comment__") {
                        // Migrate old format
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

            // Restore mediaUserMap
            if (result.mediaUserMap) {
                try {
                    mediaUserMap = {};
                    for (const [mediaId, users] of Object.entries(result.mediaUserMap)) {
                        if (Array.isArray(users)) {
                            mediaUserMap[mediaId] = new Set(users);
                        } else {
                            mediaUserMap[mediaId] = new Set();
                        }
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

            // Start cache cleanup timer
            startCacheCleanupTimer();

            // Initialize extension
            initializeExtension();
        });
    } catch (e) {
        console.error("Error loading cache:", e);
        commentCache = {};
        mediaUserMap = {};
        initializeExtension();
    }
}

// Function to update comment icons based on current cache
function refreshCommentIcons() {
    const currentMediaInfo = extractMediaIdFromUrl();
    const currentMediaId = currentMediaInfo ? currentMediaInfo.id : null;

    if (!currentMediaId || !isInitialized) return;

    if (DEBUG) console.log("Refreshing comment icons based on updated cache");

    // Find the Following section
    const followingSection = document.querySelector('div[class="following"], div.following, [class^="following"], [class*=" following"]');
    if (!followingSection) return;

    // Get user entries using our helper function
    const userEntries = findUserEntries(followingSection);
    if (userEntries.length === 0) return;

    // For each entry
    for (const entry of userEntries) {
        // Remove existing icon
        const existingIcon = entry.querySelector(".comment-icon-column");
        if (existingIcon) existingIcon.remove();

        // Get username
        const nameElement = entry.querySelector("div[class='name']");
        if (!nameElement) continue;

        const username = nameElement.textContent.trim();
        const cacheKey = `${username}-${currentMediaId}`;

        // Check cache
        if (commentCache[cacheKey]) {
            const hasComment = hasCachedComment(cacheKey);

            // Add icon if there's a comment
            if (hasComment) {
                addCommentIcon(entry, username, currentMediaId, true);
            }
        }
    }

    if (DEBUG) console.log("Comment icons refreshed successfully");
}

// Storage change listener
chrome.storage.onChanged.addListener(function(changes, namespace) {
    if (namespace === 'local' && changes.commentCache) {
        // Update entire cache
        commentCache = changes.commentCache.newValue || {};

        if (DEBUG) console.log("Cache updated from another tab");

        // Update comment icons
        refreshCommentIcons();

        // Also update any open tooltips
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

// TooltipManager as ES6 class with better organization
class TooltipManager {
    static #instance = null;
    #tooltip = null;
    #currentElement = null;
    #currentUsername = null;
    #currentMediaId = null;
    #isLoading = false;
    #showTimer = null;
    #hideTimer = null;
    #isTransitioning = false;

    // Constants
    static SHOW_DELAY = 150;
    static HIDE_DELAY = 300;
    static TRANSITION_BUFFER = 150;

    constructor() {
        // Add global mouse listener
        document.addEventListener("mousemove", this.#handleMouseMove.bind(this));
    }

    static getInstance() {
        if (!TooltipManager.#instance) {
            TooltipManager.#instance = new TooltipManager();
        }
        return TooltipManager.#instance;
    }

    // PUBLIC METHODS

    show(element, username, mediaId) {
        this.#startShowTooltip(element, username, mediaId);
    }

    hide() {
        this.#startHideTooltip();
    }

    forceHide() {
        const tooltip = this.#getTooltip();
        if (tooltip) {
            tooltip.style.display = 'none';

            // Reset all icons
            const allIcons = document.querySelectorAll('.anilist-comment-icon');
            allIcons.forEach(icon => {
                icon.classList.remove('active-comment');
            });
        }
        this.#currentElement = null;
        this.#isTransitioning = false;
    }

    // Removed unused methods

    // PRIVATE METHODS

    #getTooltip() {
        if (!this.#tooltip) {
            this.#tooltip = document.getElementById("anilist-tooltip");
            if (!this.#tooltip) {
                this.#tooltip = document.createElement("div");
                this.#tooltip.id = "anilist-tooltip";
                document.body.appendChild(this.#tooltip);

                this.#tooltip.addEventListener("mouseenter", () => {
                    if (this.#hideTimer) {
                        clearTimeout(this.#hideTimer);
                        this.#hideTimer = null;
                    }
                });

                this.#tooltip.addEventListener("mouseleave", () => {
                    this.#startHideTooltip();
                });
            }
        }
        return this.#tooltip;
    }

    #positionTooltip(element) {
        const tooltip = this.#getTooltip();

        // Make tooltip visible but transparent for size calculation
        const wasHidden = tooltip.style.display === 'none';
        if (wasHidden) {
            tooltip.style.opacity = '0';
            tooltip.style.display = 'block';
        }

        // Find Following section
        const followingSection = document.querySelector('div[class="following"], div.following, [class^="following"], [class*=" following"]');
        if (!followingSection) {
            if (wasHidden) {
                setTimeout(() => { tooltip.style.opacity = '1'; }, 50);
            }
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
            if (wasHidden) {
                setTimeout(() => { tooltip.style.opacity = '1'; }, 50);
            }
            return;
        }

        const parentRect = parentEntry.getBoundingClientRect();
        const posY = window.scrollY + parentRect.top;

        // Mark hover state
        const allIcons = document.querySelectorAll('.anilist-comment-icon');
        allIcons.forEach(icon => icon.classList.remove('active-comment'));
        const hoveredIcon = element.querySelector('.anilist-comment-icon');
        if (hoveredIcon) {
            hoveredIcon.classList.add('active-comment');
        }

        // Set tooltip position
        tooltip.style.transition = "none";
        tooltip.style.left = posX + 'px';
        tooltip.style.top = posY + 'px';

        // Re-enable transitions
        setTimeout(() => {
            tooltip.style.transition = "opacity 0.2s ease";
        }, 50);

        if (wasHidden) {
            setTimeout(() => { tooltip.style.opacity = '1'; }, 50);
        }
    }

    async #startShowTooltip(element, username, mediaId) {
        // Cancel hide timer
        if (this.#hideTimer) {
            clearTimeout(this.#hideTimer);
            this.#hideTimer = null;
        }

        // Already showing for this element
        if (this.#currentElement === element && this.#tooltip && this.#tooltip.style.display === 'block') {
            return;
        }

        // Transition between elements
        if (this.#currentElement && this.#currentElement !== element && this.#tooltip && this.#tooltip.style.display === 'block') {
            this.#isTransitioning = true;

            if (this.#showTimer) {
                clearTimeout(this.#showTimer);
            }

            this.#currentElement = element;
            this.#currentUsername = username;
            this.#currentMediaId = mediaId;

            this.#positionTooltip(element);
            this.#tooltip.innerHTML = "<div class='tooltip-loading'>Loading...</div>";
            await this.#loadComment(username, mediaId);
            return;
        }

        // Start show timer
        if (!this.#showTimer) {
            this.#showTimer = setTimeout(() => {
                this.#currentElement = element;
                this.#currentUsername = username;
                this.#currentMediaId = mediaId;

                const tooltip = this.#getTooltip();
                tooltip.style.display = 'block';

                this.#positionTooltip(element);
                tooltip.innerHTML = "<div class='tooltip-loading'>Loading...</div>";
                this.#loadComment(username, mediaId);

                this.#showTimer = null;
                this.#isTransitioning = false;
            }, TooltipManager.SHOW_DELAY);
        }
    }

    #startHideTooltip() {
        if (this.#isTransitioning) {
            setTimeout(() => {
                this.#isTransitioning = false;
            }, TooltipManager.TRANSITION_BUFFER);
            return;
        }

        if (this.#showTimer) {
            clearTimeout(this.#showTimer);
            this.#showTimer = null;
        }

        if (!this.#hideTimer && this.#tooltip && this.#tooltip.style.display === 'block') {
            this.#hideTimer = setTimeout(() => {
                this.#hideTooltip();
                this.#hideTimer = null;
            }, TooltipManager.HIDE_DELAY);
        }
    }

    #hideTooltip() {
        if (this.#tooltip) {
            this.#tooltip.style.display = 'none';

            // Reset all icons
            const allIcons = document.querySelectorAll('.anilist-comment-icon');
            allIcons.forEach(icon => {
                icon.classList.remove('active-comment');
            });
        }
        this.#currentElement = null;
        this.#isTransitioning = false;
    }

    async #loadComment(username, mediaId) {
        this.#isLoading = true;

        // Cache key
        const reqCacheKey = `${username}-${mediaId}`;

        // Try cache first
        let comment = null;
        let cacheIsValid = false;
        const now = Date.now();

        if (commentCache[reqCacheKey]) {
            if (typeof commentCache[reqCacheKey] === 'object' && commentCache[reqCacheKey].content) {
                comment = commentCache[reqCacheKey].content;

                // Check if still valid
                if (commentCache[reqCacheKey].timestamp &&
                    (now - commentCache[reqCacheKey].timestamp) < CACHE_MAX_AGE) {
                    cacheIsValid = true;
                }
            } else if (typeof commentCache[reqCacheKey] === 'string' &&
                commentCache[reqCacheKey] !== "__has_comment__") {
                comment = commentCache[reqCacheKey];
            }

            // Show cached content
            if (comment) {
                window.updateTooltipContent(this.#tooltip, comment, username, mediaId);

                // Skip API if valid or rate limited
                if (cacheIsValid || isRateLimited) {
                    this.#isLoading = false;
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
                    const newCacheKey = `${username}-${mediaId}`;
                    commentCache[newCacheKey] = {
                        content: comment || '',
                        timestamp: Date.now()
                    };

                    saveCache();

                    // Update if still current
                    if (this.#currentUsername === username && this.#currentMediaId === mediaId) {
                        window.updateTooltipContent(this.#tooltip, comment, username, mediaId);
                    }
                } else {
                    // Rate limited
                    this.#tooltip.innerHTML = "<div class='tooltip-error'>Rate limit reached. Try again later.</div>";
                    isRateLimited = true;

                    setTimeout(() => {
                        isRateLimited = false;
                        requestsInLastMinute = 0;
                    }, 60000);
                }
            } catch (error) {
                // Error loading
                if (this.#currentUsername === username && this.#currentMediaId === mediaId) {
                    this.#tooltip.innerHTML = "<div class='tooltip-error'>Error loading comment</div>";
                }
                console.error("API request error:", error);
            }
        } else {
            // Already rate limited
            this.#tooltip.innerHTML = "<div class='tooltip-error'>API rate limit reached. Try again later.</div>";
        }

        this.#isLoading = false;
    }

    #isNear(point, rect, tolerance) {
        return (
            point.x >= rect.left - tolerance &&
            point.x <= rect.right + tolerance &&
            point.y >= rect.top - tolerance &&
            point.y <= rect.bottom + tolerance
        );
    }

    #isInPath(px, py, x1, y1, x2, y2, width) {
        // Calculate distance to line
        const A = px - x1;
        const B = py - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const len_sq = C * C + D * D;

        let param = -1;
        if (len_sq !== 0) param = dot / len_sq;

        let xx, yy;

        // Find the closest point
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

    #isNearAnyCommentIcon(x, y) {
        if (!this.#currentElement) return false;

        const tolerance = 35;
        const icons = document.querySelectorAll(".anilist-comment-icon");

        for (const icon of icons) {
            // Skip current
            if (icon.closest(".comment-icon-column") === this.#currentElement) continue;

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

    #handleMouseMove(e) {
        // Skip if no active tooltip
        if (!this.#tooltip || this.#tooltip.style.display !== 'block' || !this.#currentElement) {
            return;
        }

        const elementRect = this.#currentElement.getBoundingClientRect();
        const tooltipRect = this.#tooltip.getBoundingClientRect();

        // Tolerance
        const tolerance = 25;

        // Check proximity
        const isNearElement = this.#isNear(
            { x: e.clientX, y: e.clientY },
            elementRect,
            tolerance
        );

        const isNearTooltip = this.#isNear(
            { x: e.clientX, y: e.clientY },
            tooltipRect,
            tolerance
        );

        // Check corridor
        const isInCorridor = this.#isInPath(
            e.clientX, e.clientY,
            (elementRect.left + elementRect.right) / 2,
            (elementRect.top + elementRect.bottom) / 2,
            (tooltipRect.left + tooltipRect.right) / 2,
            (tooltipRect.top + tooltipRect.bottom) / 2,
            tolerance * 2.5
        );

        // Check other icons
        const isNearAnotherIcon = this.#isNearAnyCommentIcon(e.clientX, e.clientY);

        // Keep visible in safe area
        if (isNearElement || isNearTooltip || isInCorridor || isNearAnotherIcon) {
            if (this.#hideTimer) {
                clearTimeout(this.#hideTimer);
                this.#hideTimer = null;
            }

            // Set transition
            if (isNearAnotherIcon && !isNearElement && !isNearTooltip) {
                this.#isTransitioning = true;
            }
        } else {
            // Start hiding
            this.#startHideTooltip();

            // Reset icon states when not near any relevant elements
            if (!isNearElement && !isNearTooltip && !isInCorridor && !isNearAnotherIcon) {
                const allIcons = document.querySelectorAll('.anilist-comment-icon');
                allIcons.forEach(icon => {
                    if (!icon.parentElement || !icon.parentElement.matches(':hover')) {
                        icon.classList.remove('active-comment');
                    }
                });
            }
        }
    }
}

// Setup hover listener
function setupHoverListener(element, username, mediaId) {
    const tooltipManager = TooltipManager.getInstance();
    const commentIcon = element.querySelector(".anilist-comment-icon");

    // Get the parent entry row
    const parentRow = element.closest("a");

    if (parentRow) {
        // Handle row hover state
        parentRow.addEventListener("mouseenter", () => {
            if (commentIcon) {
                commentIcon.classList.add('hover-active');
            }
        });

        parentRow.addEventListener("mouseleave", (e) => {
            // Only reset icon if not hovering the icon itself and not active
            const rect = element.getBoundingClientRect();
            const isOverIcon = e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom;

            if (!isOverIcon && commentIcon && !commentIcon.classList.contains('active-comment')) {
                resetIconState(commentIcon);
            }

            // Additional check: if we have left the row, also check tooltip
            const tooltip = document.getElementById("anilist-tooltip");
            if (tooltip && tooltip.style.display === 'block') {
                const tooltipUsername = tooltip.getAttribute('data-username');
                // If tooltip shows different username, we can reset this icon
                if (tooltipUsername !== username) {
                    resetIconState(commentIcon);
                }
            }
        });
    }

    // Icon hover handling
    element.addEventListener("mouseenter", () => {
        tooltipManager.show(element, username, mediaId);
    });

    element.addEventListener("mouseleave", () => {
        setTimeout(() => {
            tooltipManager.hide();
        }, 50);
    });

    // Return cleanup function for potential future use
    return function cleanup() {
        if (parentRow) {
            parentRow.removeEventListener("mouseenter", () => {});
            parentRow.removeEventListener("mouseleave", () => {});
        }

        element.removeEventListener("mouseenter", () => {});
        element.removeEventListener("mouseleave", () => {});
    };
}

// Helper function to reset icon state
function resetIconState(icon) {
    if (!icon) return;

    // Remove active class
    icon.classList.remove('active-comment');
    icon.classList.remove('hover-active');
}

// Window resize handler
window.addEventListener('resize', debounce(() => {
    // Reposition any visible tooltip
    const tooltip = document.getElementById("anilist-tooltip");
    if (tooltip && tooltip.style.display === 'block') {
        const tooltipManager = TooltipManager.getInstance();
        const currentElement = document.querySelector('.anilist-comment-icon.active-comment')?.closest('.comment-icon-column');

        if (currentElement) {
            // Force repositioning
            tooltipManager.forceHide();
            tooltipManager.show(currentElement,
                tooltip.getAttribute('data-username'),
                parseInt(tooltip.getAttribute('data-media-id'))
            );
        } else {
            // Hide tooltip if we can't find the related element
            tooltipManager.forceHide();
        }
    }
}, 100));

// Handle page unload
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

    // Stop timers
    if (cacheCleanupTimer) {
        clearInterval(cacheCleanupTimer);
    }

    if (periodicCheckTimer) {
        clearInterval(periodicCheckTimer);
    }

    // Save cache one last time
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

// Listen for anime/manga save events
function setupSaveEventObserver() {
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            // Check for added nodes or attribute changes
            if (mutation.type === 'childList' || mutation.type === 'attributes') {
                // Try to find the "Save" button
                const saveButton = document.querySelector('.save-btn');

                // Check if button exists and event listener hasn't been added
                if (saveButton && !saveButton.dataset.listenerAdded) {
                    saveButton.dataset.listenerAdded = "true"; // Prevent duplicate listeners

                    // Add click event listener
                    saveButton.addEventListener('click', function() {
                        if (DEBUG) console.log('Anime/manga save detected');

                        // Refresh current user comment after a delay
                        setTimeout(() => {
                            const mediaInfo = extractMediaIdFromUrl();
                            if (mediaInfo && currentUsername) {
                                queueApiRequest({
                                    type: 'checkComment',
                                    username: currentUsername,
                                    mediaId: mediaInfo.id,
                                    priority: 1
                                });
                                startProcessingRequests();
                            }
                        }, 2000);
                    });
                }
            }
        });
    });

    // Configure and start the observer
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true
    });

    return observer;
}

// Main Initialization
function initOnLoad() {
    // Load Font Awesome
    loadFontAwesome();

    // Detect username
    detectCurrentUsername();

    // Setup URL observer
    urlObserver = setupUrlObserver();

    // Setup navigation listeners
    setupNavigationListeners();

    // Load cache and initialize
    loadCacheAndInitialize();

    // Setup save event observer
    setupSaveEventObserver();
}

// Early initialization
function attemptEarlyInitialization() {
    if (document.readyState === 'loading') {
        // Document still loading, wait for DOMContentLoaded
        console.log("Document still loading, waiting for DOMContentLoaded event");
        return;
    }

    // Document already loaded, initialize immediately
    console.log("Document already loaded, initializing immediately");

    if (isExtensionContextValid()) {
        // Check if already on anime/manga page
        const mediaInfo = extractMediaIdFromUrl();
        if (mediaInfo) {
            console.log(`Already on a media page (ID: ${mediaInfo.id}), initializing extension`);
            loadCacheAndInitialize();
        } else {
            // Setup URL observer for navigation
            console.log("Not on a media page, setting up URL observer only");
            urlObserver = setupUrlObserver();
        }
    }
}

// DOMContentLoaded listener
document.addEventListener('DOMContentLoaded', () => {
    if (isExtensionContextValid()) {
        console.log("Content script loaded, starting extension");
        initOnLoad();
    }
});

// Start immediately if already loaded
attemptEarlyInitialization();

// Retry after a short delay for dynamically loaded content
setTimeout(() => {
    const mediaInfo = extractMediaIdFromUrl();
    if (mediaInfo && !isInitialized) {
        console.log("Running delayed initialization check");
        loadCacheAndInitialize();
    }
}, 1500);

// Periodic check for SPA navigation that might be missed
setInterval(() => {
    if (isExtensionContextValid()) {
        handleUrlChange();

        // Retry initialization if needed
        const mediaInfo = extractMediaIdFromUrl();
        if (mediaInfo && !isInitialized) {
            console.log("Periodic check found uninitialized media page, retrying");
            initializeExtension();
        }
    }
}, 5000);