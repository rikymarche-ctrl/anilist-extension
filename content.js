// Content script for Anilist Hover Comments
console.log("Content script successfully loaded!");

// Configuration constants for cache management
const DEBUG = false;
const FORCE_DEBUG = true; // Set to true to enable debugging

const MAX_WAIT_TIME = 30000; // 30 seconds maximum wait time for Following section

// Load Font Awesome CSS
loadFontAwesome();

// Cache for already retrieved comments (avoids repeated requests)
let commentCache = {};

// Maximum age of cache items in milliseconds
const CACHE_MAX_AGE = 12 * 60 * 60 * 1000;

// Maximum cache size in bytes (approximately 100KB)
const MAX_CACHE_SIZE_BYTES = 100 * 1024;

// Maximum number of cache entries
const MAX_CACHE_ENTRIES = 250;

// Cache cleanup timer (run every 30 minutes)
const CACHE_CLEANUP_INTERVAL = 30 * 60 * 1000;
let cacheCleanupTimer = null;

// API Request management
const MIN_REQUEST_DELAY = 2000; // Wait at least 2 seconds between requests (increased from 1.5s)
let lastRequestTime = 0;
let pendingRequests = [];
let processingRequests = false;

// Retry configuration
const MAX_RETRIES = 1; // 2 attempts total: initial + 1 retry
const RETRY_DELAY_BASE = 2000;
const RETRY_DELAY_FACTOR = 2; // Exponential backoff

// Flag to track if the extension has already been initialized on the current page
let isInitialized = false;

// Flag to indicate if we are on an anime page
let isAnimePage = false;

// Flag to indicate if polling is active
let isPollingActive = false;

// Reference to the global MutationObserver
let globalObserver = null;

// Current user name (if we can detect it)
let currentUsername = null;

// Rate limiting warning
let isRateLimited = false;
let rateLimitResetTime = null;

// Helper function to check if extension context is still valid
function isExtensionContextValid() {
    try {
        // This will throw if context is invalid
        return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
        return false;
    }
}

// Load saved cache at startup and clear expired entries
chrome.storage.local.get(['commentCache'], function(result) {
    if (result.commentCache) {
        if (DEBUG) console.log("Comment cache loaded from storage:", Object.keys(result.commentCache).length, "items");
        
        // Filter out expired cache entries
        const now = Date.now();
        const validEntries = {};
        let expiredCount = 0;
        
        for (const [key, value] of Object.entries(result.commentCache)) {
            if (typeof value === 'object' && value.timestamp && (now - value.timestamp) < CACHE_MAX_AGE) {
                validEntries[key] = value;
            } else if (typeof value === 'string' && value !== "__has_comment__") {
                // Migrate old cache format to new format with timestamp
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
            // Save the cleaned cache
            chrome.storage.local.set({commentCache: validEntries});
        }
    }
    
    // Start automatic cache cleanup timer
    startCacheCleanupTimer();
    
    // Initialize extension after cache load
    startAfterCacheLoad();
});

// Function to clean up expired cache entries
function cleanupExpiredCache() {
    if (DEBUG) console.log("Running scheduled cache cleanup");
    
    const now = Date.now();
    const validEntries = {};
    let expiredCount = 0;
    
    for (const [key, value] of Object.entries(commentCache)) {
        if (typeof value === 'object' && value.timestamp && (now - value.timestamp) < CACHE_MAX_AGE) {
            validEntries[key] = value;
        } else {
            expiredCount++;
        }
    }
    
    if (expiredCount > 0) {
        if (DEBUG) console.log(`Removed ${expiredCount} expired cache entries during scheduled cleanup`);
        commentCache = validEntries;
        saveCache();
    }
    
    // Also check for cache size limits
    checkCacheSize();
}

// Function to calculate approximate size of cache in bytes
function getCacheSizeInBytes() {
    let size = 0;
    
    // Calculate string size for each entry
    for (const [key, value] of Object.entries(commentCache)) {
        // Key size (2 bytes per character in UTF-16)
        size += key.length * 2;
        
        if (typeof value === 'object') {
            // Content size
            if (value.content) {
                size += value.content.length * 2;
            }
            
            // Timestamp (8 bytes for number)
            size += 8;
            
            // Object overhead (approximately 40 bytes)
            size += 40;
        } else if (typeof value === 'string') {
            // String size
            size += value.length * 2;
        }
    }
    
    return size;
}

// Check and trim cache based on size and entry count
function checkCacheSize() {
    const sizeInBytes = getCacheSizeInBytes();
    const numEntries = Object.keys(commentCache).length;
    
    if (DEBUG) {
        console.log(`Cache status: ${numEntries} entries, approximately ${Math.round(sizeInBytes / 1024)}KB`);
    }
    
    // Trim if either size or entry count exceeds limits
    if (sizeInBytes > MAX_CACHE_SIZE_BYTES || numEntries > MAX_CACHE_ENTRIES) {
        trimCache();
    }
}

function startAfterCacheLoad() {
    // First check if context is still valid
    if (!isExtensionContextValid()) {
        console.log("Extension context invalid, skipping initialization");
        return;
    }
    
    if (FORCE_DEBUG) {
        console.log("======= CACHE DIAGNOSTIC =======");
        console.log("Current commentCache state:", commentCache);
        
        // Check if storage matches our memory cache
        try {
            chrome.storage.local.get(['commentCache'], function(result) {
                if (!isExtensionContextValid()) return;
                
                if (result.commentCache) {
                    console.log("Storage cache has", Object.keys(result.commentCache).length, "entries");
                    
                    // Verify if timestamps match
                    let mismatchCount = 0;
                    for (const key in result.commentCache) {
                        if (commentCache[key] && 
                            typeof result.commentCache[key] === 'object' && 
                            typeof commentCache[key] === 'object') {
                            
                            const storageTimestamp = result.commentCache[key].timestamp;
                            const memoryTimestamp = commentCache[key].timestamp;
                            
                            if (storageTimestamp !== memoryTimestamp) {
                                console.log(`Timestamp mismatch for ${key}:`, {
                                    storage: new Date(storageTimestamp),
                                    memory: new Date(memoryTimestamp)
                                });
                                mismatchCount++;
                            }
                        }
                    }
                    
                    if (mismatchCount === 0) {
                        console.log("✓ No timestamp mismatches found");
                    } else {
                        console.log(`⚠ Found ${mismatchCount} timestamp mismatches`);
                    }
                }
            });
        } catch (e) {
            console.error("Error checking cache:", e);
        }
    }
    
    console.log("Initializing extension after cache load");
    initializeExtension();
}

// Enhanced hasCachedComment function to check for expiration
function hasCachedComment(cacheKey) {
    if (!commentCache[cacheKey]) return false;
    
    // New cache format (with timestamp and content)
    if (typeof commentCache[cacheKey] === 'object') {
        const content = commentCache[cacheKey].content;
        if (!content || content.trim() === '') return false;
        
        // Check if cache is expired
        const now = Date.now();
        if (commentCache[cacheKey].timestamp) {
            // Only consider valid if not expired
            const isExpired = (now - commentCache[cacheKey].timestamp) >= CACHE_MAX_AGE;
            if (isExpired && DEBUG) {
                console.log(`Cache for ${cacheKey} is expired, age: ${Math.round((now - commentCache[cacheKey].timestamp) / (60 * 1000))} minutes`);
            }
            return !isExpired;
        }
        
        return true;
    } 
    // Legacy cache format
    else if (typeof commentCache[cacheKey] === 'string') {
        if (commentCache[cacheKey] === "__has_comment__") {
            return true;
        }
        return commentCache[cacheKey] && commentCache[cacheKey].trim() !== '';
    }
    
    return false;
}

// Function to get cached comment content
function getCachedComment(cacheKey) {
    if (!commentCache[cacheKey]) return '';
    
    // New cache format (with timestamp and content)
    if (typeof commentCache[cacheKey] === 'object') {
        return commentCache[cacheKey].content || '';
    } 
    // Legacy cache format
    else if (typeof commentCache[cacheKey] === 'string') {
        if (commentCache[cacheKey] === "__has_comment__") {
            return ''; // Placeholder for legacy format
        }
        return commentCache[cacheKey] || '';
    }
    
    return '';
}

// Try to get current username as early as possible
detectCurrentUsername();

// Function to detect current username
function detectCurrentUsername() {
    // Multiple methods to try to get the current username
    
    // Method 1: Check for avatar link in the header
    const avatarLink = document.querySelector('a[href^="/user/"]');
    if (avatarLink) {
        const href = avatarLink.getAttribute('href');
        if (href && href.startsWith('/user/')) {
            currentUsername = href.replace('/user/', '');
            if (DEBUG) console.log(`Detected current user: ${currentUsername} (via avatar)`);
            return;
        }
    }
    
    // Method 2: Look for username in various places in the DOM
    // We'll check again after page has fully loaded
    setTimeout(() => {
        if (!currentUsername) {
            // Try finding it in the navigation bar
            const navLinks = document.querySelectorAll('nav a');
            for (const link of navLinks) {
                if (link.href && link.href.includes('/user/')) {
                    currentUsername = link.href.split('/user/')[1];
                    if (DEBUG) console.log(`Detected current user: ${currentUsername} (via nav)`);
                    return;
                }
            }
            
            // If we still couldn't find it, we'll proceed without it
            if (DEBUG) console.log("Could not detect current username, some features may be limited");
        }
    }, 2000);
}

// Main extension function
function initializeExtension() {
    // Check if we are on a valid media page (anime or manga)
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
    
    // Reset any previous initialization attempts
    resetInitialization();
    
    // Start the persistent detection system with retry mechanism
    startPersistentDetection(mediaId);
    
    // Add a listener for scroll, which can trigger loading of the section
    window.addEventListener('scroll', debounce(() => {
        if (!isInitialized && isAnimePage) {
            checkForFollowingSection(mediaId);
        }
    }, 500));
}

// Reset all initialization state - more thorough than just stopDetection
function resetInitialization() {
    isInitialized = false;
    stopDetection();
    // Reset rate limiting flags
    isRateLimited = false;
    rateLimitResetTime = null;
}

// Persistent detection system for the Following section
function startPersistentDetection(mediaId) {
    console.log("Starting persistent detection system...");
    
    // 1. Try immediately
    checkForFollowingSection(mediaId);
    
    // 2. Create a global observer that observes all DOM changes
    globalObserver = new MutationObserver((mutations) => {
        if (!isInitialized) {
            for (const mutation of mutations) {
                // Check if any added nodes contain our target elements
                if (mutation.addedNodes.length) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Check if this is a following section or might contain one
                            if (node.querySelector && 
                                (node.classList?.contains('following') || 
                                 node.querySelector?.('div[class="following"]'))) {
                                checkForFollowingSection(mediaId);
                                break;
                            }
                        }
                    }
                }
                
                // Also check if the target itself was modified
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
    
    // Observe changes to the DOM
    globalObserver.observe(document.body, { 
        childList: true, 
        subtree: true, 
        attributes: true,
        characterData: false
    });
    
    // 3. Start progressive polling (starts frequent, then slows down)
    startProgressivePolling(mediaId);
    
    // 4. Set a final timeout for very slow-loading pages
    setTimeout(() => {
        if (!isInitialized && document.querySelector('div[class="following"]')) {
            if (DEBUG) console.log("Final check for Following section after timeout");
            checkForFollowingSection(mediaId, true); // Force check as last resort
        }
    }, MAX_WAIT_TIME);
}

// Progressive polling (starts frequent, gradually slows down)
function startProgressivePolling(mediaId) {
    if (isPollingActive) return;
    isPollingActive = true;
    
    // Extend polling intervals and add more checks
    const intervals = [1000, 2000, 3000, 5000, 8000, 10000, 15000]; // Added longer intervals
    let currentInterval = 0;
    
    if (DEBUG) console.log(`Starting progressive polling with intervals: ${intervals.join(', ')} ms`);
    
    function poll() {
        if (isInitialized) {
            isPollingActive = false;
            if (DEBUG) console.log("Polling stopped: extension already initialized");
            return;
        }
        
        if (currentInterval >= intervals.length) {
            isPollingActive = false;
            if (DEBUG) console.log("Progressive polling completed");
            return;
        }
        
        const found = checkForFollowingSection(mediaId);
        
        if (!found) {
            // Schedule next poll with the current interval
            setTimeout(() => {
                currentInterval++;
                poll();
            }, intervals[currentInterval]);
        } else {
            isPollingActive = false;
        }
    }
    
    // Start the first poll
    poll();
}

// Improved function to check for the Following section with better user entry detection
function checkForFollowingSection(mediaId, forceCheck = false) {
	if (isInitialized && !forceCheck) return false;
    
    // DIAGNOSTIC: Check if mediaId is valid and log relevant cache entries
    if (FORCE_DEBUG && mediaId) {
        console.log(`Checking Following section for media ID: ${mediaId}`);
        
        // Look for any cached entries for this media
        const mediaEntries = Object.keys(commentCache).filter(key => key.includes(`-${mediaId}`));
        console.log(`Found ${mediaEntries.length} cached entries for this media ID`);
        
        if (mediaEntries.length > 0) {
            for (const key of mediaEntries) {
                const entry = commentCache[key];
                const timestamp = typeof entry === 'object' ? entry.timestamp : null;
                console.log(`Cache entry: ${key}`, { 
                    timestamp: timestamp ? new Date(timestamp) : 'none',
                    content: typeof entry === 'object' ? 
                        (entry.content ? entry.content.substring(0, 30) + '...' : '[empty]') : 
                        (entry ? entry.substring(0, 30) + '...' : '[empty]')
                });
            }
        }
    }
    
    // Try different CSS selectors for better compatibility
    const selectors = [
        'div[class="following"]',
        'div.following',
        '[class^="following"]',
        '[class*=" following"]'
    ];
    
    let followingSection = null;
    
    // Try each selector until we find a match
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
            followingSection = element;
            break;
        }
    }
    
    if (followingSection) {
        // First check if there's at least some content in the following section
        if (DEBUG) console.log("Following section found, checking for user entries");
        
        // Wait a short time to ensure all user entries are loaded
        setTimeout(() => {
            // Expanded selectors for user entries - more comprehensive to catch all types
            const userEntrySelectors = [
                'a[class="follow"]',
                'a.follow',
                'a[class^="follow"]',
                // Additional selectors to catch users with list entries but no ratings
                'a.user',
                'a[class*="user"]',
                'a:has(div[class="name"])'
            ];
            
            let userEntries = [];
            
            // Try each selector until we find matches
            for (const selector of userEntrySelectors) {
                try {
                    const entries = followingSection.querySelectorAll(selector);
                    if (entries.length > 0) {
                        if (DEBUG) console.log(`Found ${entries.length} user entries with selector: ${selector}`);
                        // Combine results rather than breaking after first success
                        userEntries = [...userEntries, ...Array.from(entries)];
                    }
                } catch (e) {
                    // Some selectors like :has() might not be supported in all browsers
                    if (DEBUG) console.log(`Selector error: ${e.message}`);
                }
            }
            
            // With a more robust approach that handles DOM elements
			const uniqueEntries = [];
			const seenElements = new Set();

			for (const entry of userEntries) {
				// Use a unique identifier for the entry (like its position in the DOM)
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
            } else {
                if (DEBUG) console.log("Following section found but without users, will keep checking");
            }
        }, 300); // Short delay to ensure DOM is fully loaded
    }
    
    return false;
}

// Stop all detection systems
function stopDetection() {
    // Stop the global observer if it exists
    if (globalObserver) {
        globalObserver.disconnect();
        globalObserver = null;
    }
}

// Utility function: debounce to avoid too many calls during scrolling
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

// Function to load Font Awesome
function loadFontAwesome() {
    if (document.querySelector('link[href*="fontawesome"]')) {
        if (DEBUG) console.log("Font Awesome already loaded on the page");
        return;
    }
    
    if (DEBUG) console.log("Loading Font Awesome...");
    
    // Load Font Awesome from CDN (the latest version)
    const fontAwesomeLink = document.createElement("link");
    fontAwesomeLink.rel = "stylesheet";
    fontAwesomeLink.href = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css";
    fontAwesomeLink.integrity = "sha512-z3gLpd7yknf1YoNbCzqRKc4qyor8gaKU1qmn+CShxbuBusANI9QpRohGBreCFkKxLhei6S9CQXFEbbKuqLg0DA==";
    fontAwesomeLink.crossOrigin = "anonymous";
    fontAwesomeLink.referrerPolicy = "no-referrer";
    
    document.head.appendChild(fontAwesomeLink);
    if (DEBUG) console.log("Font Awesome loaded successfully");
}

/**
 * Sets up the Following section by identifying user entries and adding comment icons where needed
 * This function handles both the current user and other users differently
 */
// Fixed function for setting up the Following section
function setupFollowingSection(followingSection, userEntries, mediaId) {
    // Prevent duplicate initialization
    if (isInitialized) return;
    
    if (DEBUG) console.log("Setting up listeners for the Following section...");
    
    // Validate that we have user entries to process
    if (userEntries.length === 0) {
        console.log("No user entries found, initialization aborted");
        return;
    }
    
    // Add rate limit warning message if needed
    if (isRateLimited) {
        addRateLimitWarning(followingSection);
    }
    
    // Queue for processing user entries with priority
    const processQueue = [];
    
    // Process all users in the list (current user and others)
    for (const entry of userEntries) {
        const nameElement = entry.querySelector("div[class='name']");
        if (nameElement) {
            const username = nameElement.textContent.trim();
            
            // Set priority (current user gets higher priority)
            const priority = (username === currentUsername) ? 1 : 2;
            
            // Add to queue
            processQueue.push({ entry, username, priority });
            
            // If this is the current user, process immediately to ensure visibility
            if (username === currentUsername) {
                if (DEBUG) console.log(`Found current user (${username}) entry, processing immediately`);
                
                // Directly check if the current user has a comment for this media
                checkCurrentUserComment(entry, username, mediaId);
            }
        }
    }
    
    // Sort the queue by priority (lower number = higher priority)
    processQueue.sort((a, b) => a.priority - b.priority);
    
    // Process each entry conservatively (to avoid rate limits)
    for (const { entry, username } of processQueue) {
        // Skip current user as we've already processed them
        if (username === currentUsername) continue;
        
        const cacheKey = `${username}-${mediaId}`;
        
        // Check if we have it in cache first
        if (commentCache[cacheKey]) {
            const hasComment = hasCachedComment(cacheKey);
            const commentContent = getCachedComment(cacheKey);
            
            if (DEBUG) {
                console.log(`Cache check for ${username}: hasComment=${hasComment}, content="${commentContent.substring(0, 30)}${commentContent.length > 30 ? '...' : ''}"`);
            }
            
            if (hasComment) {
                if (DEBUG) {
                    console.log(`Adding comment icon for ${username} from cache`);
                }
                addCommentIcon(entry, username, mediaId, true, commentContent);
                
                // IMPORTANT FIX: Don't queue an API request if we have a valid cache entry
                const now = Date.now();
                const cacheIsValid = typeof commentCache[cacheKey] === 'object' && 
                                    commentCache[cacheKey].timestamp && 
                                    (now - commentCache[cacheKey].timestamp) < CACHE_MAX_AGE;
                                    
                if (cacheIsValid) {
                    if (DEBUG) console.log(`Using valid cache for ${username}, skipping API request`);
                    continue; // Skip API request for valid cache
                }
            }
        }
        
        // Only queue an API request if we don't have a valid cache entry
        queueApiRequest({
            type: 'checkComment',
            username,
            mediaId,
            entry,
            priority: username === currentUsername ? 1 : 3
        });
    }
    
    // Start processing the API request queue
    startProcessingRequests();
    
    // Mark as initialized
    isInitialized = true;
    if (DEBUG) console.log("Initialization completed successfully!");
}

/**
 * Special function to handle the current user's comment
 * This is processed immediately and separately from the queue to ensure visibility
 */
async function checkCurrentUserComment(entry, username, mediaId) {
    if (!username || !mediaId) return;
    
    if (DEBUG) console.log(`Checking current user (${username}) comment for media ${mediaId}`);
    
    // Try to fetch the comment directly from the page if possible
    // This works when viewing your own anime list entry
    let comment = '';
    const notesElement = document.querySelector('textarea[name="notes"], div.notes');
    if (notesElement && notesElement.value) {
        comment = notesElement.value;
        if (DEBUG) console.log(`Found comment in page notes element (value): "${comment}"`);
    } else if (notesElement && notesElement.textContent) {
        comment = notesElement.textContent;
        if (DEBUG) console.log(`Found comment in page notes element (textContent): "${comment}"`);
    }
    
    // If we couldn't get it from the page, try the API
    if (!comment) {
        try {
            if (DEBUG) console.log(`No comment found on page, trying API for user ${username}`);
            comment = await fetchUserComment(username, mediaId);
        } catch (error) {
            console.error("Error fetching current user comment:", error);
            return;
        }
    }
    
    // Update cache with the actual comment
    const cacheKey = `${username}-${mediaId}`;
    commentCache[cacheKey] = {
        content: comment,
        timestamp: Date.now()
    };
    
    // If there's a comment, add the icon
    if (comment && comment.trim() !== '') {
        if (DEBUG) console.log(`Current user has comment for media ${mediaId}: "${comment}"`);
        addCommentIcon(entry, username, mediaId, true, comment);
        saveCache();
    } else {
        if (DEBUG) console.log(`Current user has no comment for media ${mediaId}`);
    }
}

// Add rate limit warning to the page
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

// Function to add comment icon and refresh button to user entries
// Funzione per aggiungere l'icona commento agli user entries
function addCommentIcon(entry, username, mediaId, hasComment, commentContent) {
    // Only proceed if the entry is still in the DOM
    if (!entry || !entry.isConnected) {
        if (DEBUG) console.log(`Entry for ${username} is no longer in the DOM, skipping icon addition`);
        return;
    }

    const scoreElement = entry.querySelector("span");
    const statusElement = entry.querySelector("div[class='status']");
    
    // Special case for current user - just a different color
    const isCurrentUser = (username === currentUsername);
    
    if (hasComment) {
        if (DEBUG) {
            console.log(`User ${username} has a comment, adding icon`);
        }
        
        // Check if we already added an icon to avoid duplicates
        if (entry.querySelector(".comment-icon-column")) {
            if (DEBUG) console.log(`Icon already exists for ${username}, skipping`);
            return;
        }
        
        // Set position relative on the entry to correctly position the icon
        if (window.getComputedStyle(entry).position === 'static') {
            entry.style.position = 'relative';
        }
        
        // Create a separate element for the icon column
        const iconColumn = document.createElement("div");
        iconColumn.className = "comment-icon-column";
        iconColumn.style.position = "absolute";
        iconColumn.style.top = "50%";
        iconColumn.style.transform = "translateY(-50%)";
        
        // If there's a status element, position the icon after the status, otherwise before the score
        if (statusElement) {
            const statusRect = statusElement.getBoundingClientRect();
            const entryRect = entry.getBoundingClientRect();
            // Position the icon to the right of the status with a small margin
            iconColumn.style.right = `${entryRect.right - statusRect.right + 10}px`;
        } else {
            // If there's no status, position the icon at a fixed distance from the right
            iconColumn.style.right = "60px";
        }
        
        // Create the Font Awesome comment icon (fa-comment)
        const commentIcon = document.createElement("i");
        commentIcon.className = "fa-solid fa-comment anilist-comment-icon";
        commentIcon.style.fontSize = "14px";
        commentIcon.style.cursor = "pointer";
        
        // Ensure icon is visible by adding explicit styles
        commentIcon.style.display = "inline-block";
        commentIcon.style.visibility = "visible";
        
        // Add the icon to the column
        iconColumn.appendChild(commentIcon);
        
        // Stop click propagation on the icon column
        iconColumn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
        
        // Add the icon column to the entry
        entry.appendChild(iconColumn);
        
        // Set up the hover listener with the comment content if we have it
        setupHoverListener(iconColumn, username, mediaId, commentContent);
    }
}

// Enhanced tooltip content update function with improved refresh handling
window.updateTooltipContent = function(tooltip, comment, username, mediaId) {
    tooltip.textContent = "";
    
    // Create a container for the comment content
    const contentContainer = document.createElement("div");
    contentContainer.className = "tooltip-content";
    
    if (comment && comment.trim() !== "") {
        const commentDiv = document.createElement("div");
        commentDiv.className = "comment";
        commentDiv.textContent = comment;
        contentContainer.appendChild(commentDiv);
    } else {
        const noCommentDiv = document.createElement("div");
        noCommentDiv.className = "no-comment";
        noCommentDiv.textContent = "No comment";
        contentContainer.appendChild(noCommentDiv);
    }
    
    // Add the container to the tooltip
    tooltip.appendChild(contentContainer);
    
    // Get cache date for this comment
    let cacheDate = null;
    let cacheAge = null;
    const cacheKey = `${username}-${mediaId}`;
    
    if (commentCache[cacheKey]) {
        if (typeof commentCache[cacheKey] === 'object' && commentCache[cacheKey].timestamp) {
            cacheDate = new Date(commentCache[cacheKey].timestamp);
            
            // Calculate cache age in milliseconds
            const now = Date.now();
            cacheAge = now - commentCache[cacheKey].timestamp;
            
            if (DEBUG) {
                console.log(`Tooltip for ${username}: cache age is ${Math.round(cacheAge / (60 * 1000))} minutes`);
            }
        } else if (DEBUG) {
            console.log(`Tooltip for ${username}: cache entry has no timestamp`);
        }
    }
    
    // Add footer with refresh button and cache info
    const footerDiv = document.createElement("div");
    footerDiv.className = "tooltip-footer";
    
    // Cache information text
    const infoSpan = document.createElement("span");
    infoSpan.className = "tooltip-info";
    
    if (cacheDate) {
        // Format cache age in user-friendly way
        const timeAgo = getTimeAgo(cacheDate);
        
        // Add data attribute with actual timestamp for debugging
        infoSpan.setAttribute('data-timestamp', cacheDate.toISOString());
        infoSpan.setAttribute('data-age-ms', cacheAge);
        
        // Show warning if cache is getting old (75% of max age)
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
    
    // Function to handle refresh
    const handleRefresh = async () => {
        // Change icon to spinner and disable button during refresh
        refreshButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...';
        refreshButton.disabled = true;
        
        try {
            // Fetch fresh comment with timeout protection
            const fetchPromise = fetchUserComment(username, mediaId);
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error("Request timed out")), 8000)
            );
            
            const freshComment = await Promise.race([fetchPromise, timeoutPromise]);
            
            // Update cache with the latest comment
            const cacheKey = `${username}-${mediaId}`;
            const now = Date.now();
            
            // IMPORTANT FIX: Ensure we're saving with the correct timestamp format
            commentCache[cacheKey] = {
                content: freshComment || '',
                timestamp: now // Use numeric timestamp
            };
            
            if (DEBUG) {
                console.log(`Refreshed comment for ${username}`, {
                    timestamp: new Date(now),
                    content: freshComment ? freshComment.substring(0, 30) + '...' : '[empty]'
                });
            }
            
            saveCache();
            
            // Update tooltip content
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
            
            // Update the cache date text with the correct timestamp
            const infoSpan = tooltip.querySelector(".tooltip-info");
            if (infoSpan) {
                infoSpan.textContent = `Cached just now`;
                infoSpan.setAttribute('data-timestamp', new Date(now).toISOString());
                infoSpan.setAttribute('data-age-ms', '0');
                infoSpan.style.color = ""; // Reset color
            }
            
            // Reset button
            refreshButton.innerHTML = '<i class="fa-solid fa-check"></i> Updated';
            setTimeout(() => {
                refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Refresh';
                refreshButton.disabled = false;
            }, 2000);
            
        } catch (error) {
            // Handle error
            console.error("Error refreshing comment:", error);
            refreshButton.innerHTML = '<i class="fa-solid fa-exclamation-circle"></i> Error';
            
            setTimeout(() => {
                refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Retry';
                refreshButton.disabled = false;
            }, 2000);
        }
    };
    
    // Add event listener to refresh button
    refreshButton.addEventListener("click", handleRefresh);
    
    // Add elements to footer
    footerDiv.appendChild(infoSpan);
    footerDiv.appendChild(refreshButton);
    
    // Add footer to tooltip
    tooltip.appendChild(footerDiv);
};

// Enhanced "time ago" formatter with more precise time ranges
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
        // For older dates, show actual date
        const options = { day: 'numeric', month: 'short', year: 'numeric' };
        return `on ${date.toLocaleDateString(undefined, options)}`;
    }
}

// API Request Queue Management
function queueApiRequest(request) {
    // Don't queue if already rate limited
    if (isRateLimited) {
        if (DEBUG) console.log(`Skipping API request for ${request.username} due to rate limit`);
        return;
    }
    
    // Add to pending queue
    pendingRequests.push(request);
    
    // Sort by priority (1 is highest)
    pendingRequests.sort((a, b) => a.priority - b.priority);
    
    if (DEBUG) console.log(`Queued API request for ${request.username}, queue length: ${pendingRequests.length}`);
}

// Constants for parallel request management
const BATCH_SIZE = 4; // Process this many requests in parallel
const BATCH_COOLDOWN = 3000; // Wait between batches (ms)
const MAX_REQUESTS_PER_MINUTE = 20; // Keep the same rate limit
const MIN_BATCH_SPREAD = 300; // Minimum ms between requests in a batch (to avoid API hammering)

// Tracking variables
let requestsInLastMinute = 0;
let lastMinuteReset = Date.now();
let activeBatchCount = 0; // Track how many batches are currently active

// Process API requests with batching
function startProcessingRequests() {
    if (processingRequests || pendingRequests.length === 0 || isRateLimited) return;
    
    // Optimize the queue before processing
    optimizeRequestQueue();
    
    // If queue is empty after optimization, we're done
    if (pendingRequests.length === 0) return;
    
    processingRequests = true;
    processNextBatch();
}

// Pre-process the queue to avoid unnecessary API calls
function optimizeRequestQueue() {
    if (pendingRequests.length <= 1) return;
    
    const optimizedQueue = [];
    const processedKeys = new Set();
    
    // Process in order of priority
    pendingRequests.sort((a, b) => a.priority - b.priority);
    
    for (const request of pendingRequests) {
        const cacheKey = `${request.username}-${request.mediaId}`;
        
        // Skip duplicate requests for the same user+media
        if (processedKeys.has(cacheKey)) continue;
        processedKeys.add(cacheKey);
        
        // Skip if we have a fresh cache entry
        if (shouldUseCache(cacheKey)) {
            // If we have entry and comment exists, add icon directly from cache
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
        
        // Keep this request in the queue
        optimizedQueue.push(request);
    }
    
    // Update the queue with optimized version
    pendingRequests = optimizedQueue;
    
    if (DEBUG) {
        console.log(`Queue optimized: ${pendingRequests.length} requests after removing duplicates and using cache`);
    }
}

// Improved cache management to reduce API calls
function shouldUseCache(cacheKey) {
    if (!commentCache[cacheKey]) return false;
    
    const now = Date.now();
    
    // Consider cache still valid if less than 75% of max age
    if (typeof commentCache[cacheKey] === 'object' && 
        commentCache[cacheKey].timestamp) {
        
        const cacheAge = now - commentCache[cacheKey].timestamp;
        const isFresh = cacheAge < (CACHE_MAX_AGE * 0.75);
        
        // If many pending requests, use cache more aggressively
        if (pendingRequests.length > 15) {
            return isFresh || cacheAge < CACHE_MAX_AGE;
        }
        
        return isFresh;
    }
    
    return false;
}

// Process the next batch of requests
async function processNextBatch() {
    // Check if context is still valid
    if (chrome.runtime?.id === undefined) {
        console.log("Extension context invalidated, stopping request processing");
        processingRequests = false;
        return;
    }

    if (pendingRequests.length === 0 || isRateLimited) {
        processingRequests = false;
        return;
    }
    
    // Check for rate limiting
    const now = Date.now();
    
    // Reset counter if a minute has passed
    if (now - lastMinuteReset > 60000) {
        requestsInLastMinute = 0;
        lastMinuteReset = now;
    }
    
    // Check available "slots" within rate limit
    const availableSlots = MAX_REQUESTS_PER_MINUTE - requestsInLastMinute;
    
    // If we've nearly hit the rate limit, wait
    if (availableSlots <= 2) {
        if (DEBUG) console.log("Approaching rate limit, cooling down...");
        setTimeout(() => {
            processNextBatch();
        }, 10000); // Cool down for 10 seconds
        return;
    }
    
    // Take the next batch (limited by available slots and BATCH_SIZE)
    const batchSize = Math.min(availableSlots - 1, BATCH_SIZE, pendingRequests.length);
    
    if (DEBUG) console.log(`Processing batch of ${batchSize} requests, ${pendingRequests.length - batchSize} remaining in queue`);
    
    // Take next N requests based on priority
    const batch = pendingRequests.splice(0, batchSize);
    
    // Update tracking
    requestsInLastMinute += batchSize;
    activeBatchCount++;
    
    // Process all requests in the batch with a slight delay between each
    const batchPromises = batch.map((request, index) => {
        // Spread requests slightly to avoid hammering the API
        const spreadDelay = index * MIN_BATCH_SPREAD;
        
        return new Promise(async (resolve) => {
            // Add small delay for each request in batch
            if (spreadDelay > 0) {
                await new Promise(r => setTimeout(r, spreadDelay));
            }
            
            try {
                // Process the request
                if (request.type === 'checkComment') {
                    // Fetch comment with retry
                    const comment = await fetchUserComment(request.username, request.mediaId);
                    
                    // Update cache
                    const cacheKey = `${request.username}-${request.mediaId}`;
                    const hasComment = comment && comment.trim() !== '';
                    
                    commentCache[cacheKey] = {
                        content: comment || '',
                        timestamp: Date.now()
                    };
                    
                    // If we have an entry element and the comment exists, add the icon
                    if (request.entry && hasComment) {
                        addCommentIcon(request.entry, request.username, request.mediaId, hasComment, comment);
                    }
                }
                
                resolve();
            } catch (error) {
                console.error(`Error processing request for ${request.username}:`, error);
                
                // Handle rate limiting errors
                if (error.message && (
                    error.message.includes('429') || 
                    error.message.includes('rate limit') || 
                    error.message.includes('too many requests')
                )) {
                    isRateLimited = true;
                    rateLimitResetTime = Date.now() + 300000; // 5 minutes cooldown
                    
                    // Add warning to the UI
                    const followingSection = document.querySelector('div[class="following"]');
                    if (followingSection && !document.querySelector('.rate-limit-warning')) {
                        addRateLimitWarning(followingSection);
                    }
                    
                    if (DEBUG) console.log("Rate limit detected from API response. Cooling down for 5 minutes.");
                }
                
                resolve(); // Resolve even on error to continue the batch
            }
        });
    });
    
    // Wait for all requests in the batch to complete
    await Promise.all(batchPromises);
    
    // Save cache periodically
    if (Object.keys(commentCache).length % 10 === 0) {
        saveCache();
    }
    
    // Decrement active batch count
    activeBatchCount--;
    
    // Schedule the next batch
    if (pendingRequests.length > 0 && !isRateLimited) {
        setTimeout(() => {
            processNextBatch();
        }, BATCH_COOLDOWN);
    } else {
        processingRequests = activeBatchCount > 0;
    }
}

// Process the next request in queue
async function processNextRequest() {
    // Check if context is still valid
    if (chrome.runtime?.id === undefined) {
        console.log("Extension context invalidated, stopping request processing");
        processingRequests = false;
        return;
    }

    if (pendingRequests.length === 0 || isRateLimited) {
        processingRequests = false;
        return;
    }
    
    // Check for rate limiting
    const now = Date.now();
    
    // Reset counter if a minute has passed
    if (now - lastMinuteReset > 60000) {
        requestsInLastMinute = 0;
        lastMinuteReset = now;
    }
    
    // Check if we've hit the rate limit
    if (requestsInLastMinute >= MAX_REQUESTS_PER_MINUTE) {
        console.log(`Rate limit reached (${MAX_REQUESTS_PER_MINUTE} requests per minute). Pausing for 90 seconds.`);
        isRateLimited = true;
        rateLimitResetTime = now + 90000; // Increased from 60s to 90s
        
        // Add warning to the UI
        const followingSection = document.querySelector('div[class="following"]');
        if (followingSection && !document.querySelector('.rate-limit-warning')) {
            addRateLimitWarning(followingSection);
        }
        
        // Process only high-priority requests from cache if possible
        if (pendingRequests.length > 0) {
            const highPriorityRequests = pendingRequests.filter(req => req.priority === 1);
            for (const request of highPriorityRequests) {
                // Only process if we have cache data
                const cacheKey = `${request.username}-${request.mediaId}`;
                if (commentCache[cacheKey]) {
                    if (request.type === 'checkComment' && request.entry) {
                        const content = typeof commentCache[cacheKey] === 'object' ? 
                            commentCache[cacheKey].content : 
                            commentCache[cacheKey];
                        const hasComment = content && content !== "__has_comment__" && content.trim() !== '';
                        addCommentIcon(request.entry, request.username, request.mediaId, hasComment, content);
                    }
                    // Remove from queue
                    pendingRequests = pendingRequests.filter(req => 
                        !(req.username === request.username && req.mediaId === request.mediaId)
                    );
                }
            }
        }
        
        // Set timeout to resume after cooldown period
        setTimeout(() => {
            // Check if context is still valid before continuing
            if (chrome.runtime?.id === undefined) {
                console.log("Extension context invalidated during rate limit cooldown");
                return;
            }
            
            isRateLimited = false;
            rateLimitResetTime = null;
            requestsInLastMinute = 0;
            lastMinuteReset = Date.now();
            
            // Remove warning from UI
            const warningElement = document.querySelector('.rate-limit-warning');
            if (warningElement) {
                warningElement.remove();
            }
            
            console.log("Resuming API requests after rate limit cooldown");
            processingRequests = false;
            startProcessingRequests();
        }, 90000);
        
        return;
    }
    
    // Wait for minimum delay between requests
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_DELAY) {
        try {
            await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_DELAY - timeSinceLastRequest));
            // Check context again after waiting
            if (chrome.runtime?.id === undefined) {
                console.log("Extension context invalidated during request delay");
                processingRequests = false;
                return;
            }
        } catch (error) {
            console.error("Error during request delay:", error);
            processingRequests = false;
            return;
        }
    }
    
    // Get next request
    const request = pendingRequests.shift();
    
    try {
        // Check context again before processing request
        if (chrome.runtime?.id === undefined) {
            console.log("Extension context invalidated before processing request");
            processingRequests = false;
            return;
        }
        
        // Process based on request type
        if (request.type === 'checkComment') {
            // Check if the user has a comment
            const comment = await fetchUserComment(request.username, request.mediaId);
            
            // Check context again after async operation
            if (chrome.runtime?.id === undefined) {
                console.log("Extension context invalidated after fetching comment");
                processingRequests = false;
                return;
            }
            
            // Cache the result
            const cacheKey = `${request.username}-${request.mediaId}`;
            const hasComment = comment && comment.trim() !== '';
            
            commentCache[cacheKey] = {
                content: comment || '',
                timestamp: Date.now()
            };
            
            // If we have an entry element and the comment exists, add the icon
            if (request.entry && hasComment) {
                addCommentIcon(request.entry, request.username, request.mediaId, hasComment, comment);
            }
            
            // Save cache periodically
            if (Object.keys(commentCache).length % 10 === 0) {
                if (chrome.runtime?.id !== undefined) {
                    saveCache();
                }
            }
        }
    } catch (error) {
        console.error(`Error processing request:`, error);
        
        // Check for extension context before continuing
        if (chrome.runtime?.id === undefined) {
            console.log("Extension context invalidated during error handling");
            processingRequests = false;
            return;
        }
        
        // Check for specific rate limit errors
        if (error.message && (
            error.message.includes('429') || 
            error.message.includes('rate limit') || 
            error.message.includes('too many requests')
        )) {
            isRateLimited = true;
            rateLimitResetTime = Date.now() + 300000; // 5 minutes cooldown
            
            // Add warning to the UI
            const followingSection = document.querySelector('div[class="following"]');
            if (followingSection && !document.querySelector('.rate-limit-warning')) {
                addRateLimitWarning(followingSection);
            }
            
            if (DEBUG) console.log("Rate limit detected from API response. Cooling down for 5 minutes.");
            
            // Set timeout to resume
            setTimeout(() => {
                // Check context before resuming
                if (chrome.runtime?.id === undefined) {
                    console.log("Extension context invalidated during rate limit cooldown");
                    return;
                }
                
                isRateLimited = false;
                rateLimitResetTime = null;
                requestsInLastMinute = 0;
                lastMinuteReset = Date.now();
                
                // Remove warning from UI
                const warningElement = document.querySelector('.rate-limit-warning');
                if (warningElement) {
                    warningElement.remove();
                }
                
                if (DEBUG) console.log("Resuming API requests after rate limit cooldown");
                processingRequests = false;
                startProcessingRequests();
            }, 300000);
            
            return;
        }
    }
    
    // Check context before updating tracking and scheduling next request
    if (chrome.runtime?.id === undefined) {
        console.log("Extension context invalidated after request processing");
        processingRequests = false;
        return;
    }
    
    // Update request tracking
    lastRequestTime = Date.now();
    requestsInLastMinute++;
    
    // Small delay before processing next request
    setTimeout(() => {
        // Final context check
        if (chrome.runtime?.id === undefined) {
            console.log("Extension context invalidated before next request");
            processingRequests = false;
            return;
        }
        processNextRequest();
    }, MIN_REQUEST_DELAY);
}

// Save cache to storage with improved error handling
function saveCache() {
    // Context check
    if (chrome.runtime?.id === undefined) {
        console.log("Extension context invalidated, can't save cache");
        return;
    }
    
    try {
        chrome.storage.local.set({ commentCache }, function() {
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

// Handle cleanup on page unload
window.addEventListener("unload", () => {
    // Cancel any pending timeouts or requests
    pendingRequests = [];
    processingRequests = false;
    
    // Clear any active observers
    if (globalObserver) {
        globalObserver.disconnect();
        globalObserver = null;
    }
    
    if (urlObserver) {
        urlObserver.disconnect();
    }
	
	// Stop cache cleanup timer
    if (cacheCleanupTimer) {
        clearInterval(cacheCleanupTimer);
        cacheCleanupTimer = null;
    }
    
    // Save cache one last time if possible
    if (chrome.runtime?.id !== undefined && Object.keys(commentCache).length > 0) {
        try {
            // Use synchronous storage for unload
            chrome.storage.local.set({ commentCache });
        } catch (error) {
            console.error("Error saving cache on unload:", error);
        }
    }
});

// Save cache to storage
function saveCache() {
    // Limit cache size if needed
    if (Object.keys(commentCache).length > MAX_CACHE_SIZE) {
        trimCache();
    }
    
    chrome.storage.local.set({ commentCache }, function() {
        if (DEBUG) console.log(`Comment cache saved with ${Object.keys(commentCache).length} items`);
    });
}

// Trim cache to maximum size
function trimCache() {
    // Convert cache to array of [key, {content, timestamp}] pairs
    const cacheEntries = Object.entries(commentCache);
    
    // Sort by timestamp (oldest first)
    cacheEntries.sort((a, b) => {
        const timeA = typeof a[1] === 'object' ? (a[1].timestamp || 0) : 0;
        const timeB = typeof b[1] === 'object' ? (b[1].timestamp || 0) : 0;
        return timeA - timeB;
    });
    
    // Calculate how many entries to remove
    // Target: 80% of maximum to provide buffer space
    const targetEntries = Math.floor(MAX_CACHE_ENTRIES * 0.8);
    let entriesToRemove = Math.max(0, cacheEntries.length - targetEntries);
    
    if (DEBUG) console.log(`Trimming cache: removing ${entriesToRemove} oldest entries`);
    
    // Remove oldest entries
    const newCache = {};
    
    // Keep only the newer entries
    for (let i = entriesToRemove; i < cacheEntries.length; i++) {
        newCache[cacheEntries[i][0]] = cacheEntries[i][1];
    }
    
    commentCache = newCache;
    
    // Save the trimmed cache
    saveCache();
    
    if (DEBUG) {
        const newSize = getCacheSizeInBytes();
        console.log(`Cache after trimming: ${Object.keys(commentCache).length} entries, approximately ${Math.round(newSize / 1024)}KB`);
    }
}

// Tooltip manager - gestisce tutti i tooltip a livello globale
const TooltipManager = (function() {
    // Singleton instance
    let instance;
    
    // Tooltip element
    let tooltip = null;
    
    // Stato del tooltip
    let currentElement = null;
    let currentUsername = null;
    let currentMediaId = null;
    let isLoading = false;
    
    // Timer
    let showTimer = null;
    let hideTimer = null;
    
    // Costanti
    const SHOW_DELAY = 150;   // ms di ritardo prima di mostrare un tooltip
    const HIDE_DELAY = 300;   // ms di ritardo prima di nascondere un tooltip
    const TRANSITION_BUFFER = 150; // ms di buffer per le transizioni
    
    // Flag che indica se siamo in una transizione
    let isTransitioning = false;
    
    // Ultimo evento mouse
    let lastMouseEvent = null;
    
    // Ottiene o crea l'elemento tooltip
    function getTooltip() {
        if (!tooltip) {
            tooltip = document.getElementById("anilist-tooltip");
            if (!tooltip) {
                tooltip = document.createElement("div");
                tooltip.id = "anilist-tooltip";
                document.body.appendChild(tooltip);
                
                // Ascoltatore per il movimento del mouse sul tooltip
                tooltip.addEventListener("mouseenter", function() {
                    // Se il mouse entra nel tooltip, annulliamo il timer di nascondimento
                    if (hideTimer) {
                        clearTimeout(hideTimer);
                        hideTimer = null;
                    }
                });
                
                tooltip.addEventListener("mouseleave", function() {
                    // Nascondi il tooltip dopo il ritardo specificato
                    startHideTooltip();
                });
            }
        }
        return tooltip;
    }
    
    // Posiziona il tooltip vicino all'elemento
    function positionTooltip(element) {
        const tooltip = getTooltip();
        const elementRect = element.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Assicuriamoci che il tooltip sia visibile per ottenere le dimensioni
        const wasHidden = tooltip.style.display === 'none';
        if (wasHidden) {
            tooltip.style.opacity = '0';
            tooltip.style.display = 'block';
        }
        
        // Ottieni le dimensioni del tooltip
        const tooltipWidth = tooltip.offsetWidth;
        const tooltipHeight = tooltip.offsetHeight;
        
        // Trova lo score element
        const userEntry = element.closest("a[class='follow']") || element.closest("a.follow");
        const scoreElement = userEntry ? userEntry.querySelector("span") : null;
        
        // Calcola la posizione X - prova prima a posizionare a destra
        let posX = elementRect.right + 10 + window.scrollX;
        
        // Calcola la posizione Y - posiziona sotto il punteggio se possibile
        let posY;
        if (scoreElement) {
            const scoreRect = scoreElement.getBoundingClientRect();
            // Posiziona sotto l'elemento score con un piccolo margine
            posY = scoreRect.bottom + 5 + window.scrollY;
        } else {
            // Fallback al centro dell'elemento
            posY = elementRect.top + (elementRect.height / 2) + window.scrollY;
        }
        
        // Se troppo vicino al bordo destro, posiziona a sinistra
        if (posX + tooltipWidth > viewportWidth - 20) {
            posX = elementRect.left - tooltipWidth - 10 + window.scrollX;
        }
        
        // Se troppo vicino al bordo inferiore, regola la posizione Y
        if (posY + tooltipHeight > viewportHeight + window.scrollY - 20) {
            posY = Math.max(window.scrollY + 10, 
                           (elementRect.bottom - tooltipHeight) + window.scrollY);
        }
        
        // Imposta la posizione finale
        tooltip.style.left = posX + 'px';
        tooltip.style.top = posY + 'px';
        
        // Ripristina la visibilità
        if (wasHidden) {
            tooltip.style.opacity = '1';
        }
    }
    
    // Inizia il timer per mostrare il tooltip
    function startShowTooltip(element, username, mediaId) {
        // Cancella eventuali timer di nascondimento
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        
        // Se stiamo già mostrando per questo elemento, non fare nulla
        if (currentElement === element && tooltip && tooltip.style.display === 'block') {
            return;
        }
        
        // Se stiamo mostrando per un altro elemento, imposta la transizione
        if (currentElement && currentElement !== element && tooltip && tooltip.style.display === 'block') {
            isTransitioning = true;
            
            // Conserviamo temporaneamente il contenuto attuale
            const currentTooltip = tooltip;
            
            // Inizia a mostrare immediatamente il nuovo tooltip
            if (showTimer) {
                clearTimeout(showTimer);
            }
            
            // Mostra il nuovo tooltip
            currentElement = element;
            currentUsername = username;
            currentMediaId = mediaId;
            
            // Posiziona il tooltip per il nuovo elemento
            positionTooltip(element);
            
            // Aggiorna il contenuto con "Caricamento..."
            updateTooltipContent("Loading...");
            
            // Carica il commento
            loadComment(username, mediaId);
            return;
        }
        
        // Altrimenti, imposta un timer per mostrare
        if (!showTimer) {
            showTimer = setTimeout(() => {
                currentElement = element;
                currentUsername = username;
                currentMediaId = mediaId;
                
                const tooltip = getTooltip();
                tooltip.style.display = 'block';
                
                // Posiziona il tooltip
                positionTooltip(element);
                
                // Mostra lo stato di caricamento
                updateTooltipContent("Loading...");
                
                // Carica il commento
                loadComment(username, mediaId);
                
                showTimer = null;
                isTransitioning = false;
            }, SHOW_DELAY);
        }
    }
    
    // Inizia il timer per nascondere il tooltip
    function startHideTooltip() {
        // Se siamo in transizione, non nascondere
        if (isTransitioning) {
            setTimeout(() => {
                isTransitioning = false;
            }, TRANSITION_BUFFER);
            return;
        }
        
        // Cancella il timer di visualizzazione
        if (showTimer) {
            clearTimeout(showTimer);
            showTimer = null;
        }
        
        // Imposta un timer per nascondere
        if (!hideTimer && tooltip && tooltip.style.display === 'block') {
            hideTimer = setTimeout(() => {
                hideTooltip();
                hideTimer = null;
            }, HIDE_DELAY);
        }
    }
    
    // Nasconde immediatamente il tooltip
    function hideTooltip() {
        if (tooltip) {
            tooltip.style.display = 'none';
        }
        currentElement = null;
        isTransitioning = false;
    }
    
    // Aggiorna il contenuto del tooltip
    function updateTooltipContent(content) {
        const tooltip = getTooltip();
        
        if (content === "Loading...") {
            tooltip.innerHTML = "<div class='tooltip-loading'>Loading...</div>";
            return;
        }
        
        // Utilizza la funzione esterna per aggiornare il contenuto
        if (window.updateTooltipContent && typeof window.updateTooltipContent === 'function') {
            window.updateTooltipContent(tooltip, content, currentUsername, currentMediaId);
        } else {
            // Fallback se la funzione esterna non è disponibile
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
    
    // Carica il commento dall'API o dalla cache
    async function loadComment(username, mediaId) {
        isLoading = true;
		
		// Key for cache
		const cacheKey = `${username}-${mediaId}`;
		
		// Try cache first
		let comment = null;
		let cacheIsValid = false;
		const now = Date.now();
		
		if (commentCache[cacheKey]) {
			if (typeof commentCache[cacheKey] === 'object' && commentCache[cacheKey].content) {
				comment = commentCache[cacheKey].content;
				
				// Check if cache is still valid (not expired)
				if (commentCache[cacheKey].timestamp && 
					(now - commentCache[cacheKey].timestamp) < CACHE_MAX_AGE) {
					cacheIsValid = true;
					
					if (FORCE_DEBUG) {
						console.log(`Using valid cache for tooltip: ${username}`, {
							cached: new Date(commentCache[cacheKey].timestamp),
							age: Math.round((now - commentCache[cacheKey].timestamp) / (60 * 1000)) + ' minutes'
						});
					}
				}
			} else if (typeof commentCache[cacheKey] === 'string' && 
					   commentCache[cacheKey] !== "__has_comment__") {
				comment = commentCache[cacheKey];
			}
			
			// If we have any comment in cache, show it immediately
			if (comment) {
				updateTooltipContent(comment);
				
				// If cache is still valid, we're done
				if (cacheIsValid) {
					isLoading = false;
					return;
				}
				
				// If we're rate limited, use cached content even if expired
				if (isRateLimited) {
					isLoading = false;
					return;
				}
				
				// Otherwise continue to refresh in the background
				if (FORCE_DEBUG) {
					console.log(`Cache expired, refreshing in background for: ${username}`);
				}
			}
		}
        
        // Altrimenti, carica dall'API
        if (!cacheIsValid && !isRateLimited) {
			if (FORCE_DEBUG) {
				console.log(`Making API request for: ${username}`);
			}
            try {
                // Aggiungi al contatore dei limiti di rate
                const now = Date.now();
                if (now - lastMinuteReset > 60000) {
                    requestsInLastMinute = 1;
                    lastMinuteReset = now;
                } else {
                    requestsInLastMinute++;
                }
                
                // Carica solo se non abbiamo raggiunto il limite
                if (requestsInLastMinute <= MAX_REQUESTS_PER_MINUTE) {
                    comment = await fetchUserComment(username, mediaId);
                    
                    // Aggiorna la cache
                    commentCache[cacheKey] = {
                        content: comment || '',
                        timestamp: Date.now()
                    };
                    
                    // Salva la cache
                    saveCache();
                    
                    // Verifica che sia ancora il tooltip corrente
                    if (currentUsername === username && currentMediaId === mediaId) {
                        updateTooltipContent(comment);
                    }
                } else {
                    // Limite di rate raggiunto
                    updateTooltipContent("Rate limit reached. Try again later.");
                    isRateLimited = true;
                    
                    // Imposta un timeout per cancellare il limite
                    setTimeout(() => {
                        isRateLimited = false;
                        requestsInLastMinute = 0;
                    }, 60000);
                }
            } catch (error) {
                // Errore durante il caricamento
                if (currentUsername === username && currentMediaId === mediaId) {
                    updateTooltipContent("Error loading comment");
                }
                console.error("API request error:", error);
            }
        } else {
            // Già in stato di rate limit
            updateTooltipContent("API rate limit reached. Try again later.");
        }
        
        isLoading = false;
    }
    
    // Verifica se il punto è in un'area vicino a un elemento
    function isNear(point, rect, tolerance) {
        return (
            point.x >= rect.left - tolerance &&
            point.x <= rect.right + tolerance &&
            point.y >= rect.top - tolerance &&
            point.y <= rect.bottom + tolerance
        );
    }
    
    // Verifica se il punto è nel percorso tra due punti
    function isInPath(px, py, x1, y1, x2, y2, width) {
        // Calcola la distanza dal punto alla linea
        const A = px - x1;
        const B = py - y1;
        const C = x2 - x1;
        const D = y2 - y1;
        
        const dot = A * C + B * D;
        const len_sq = C * C + D * D;
        
        // Parametro sulla linea
        let param = -1;
        if (len_sq != 0) param = dot / len_sq;
        
        let xx, yy;
        
        // Trova il punto più vicino sulla linea
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
        
        // Calcola la distanza
        const dx = px - xx;
        const dy = py - yy;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        return distance < width;
    }
    
    // Gestore del movimento del mouse globale
    function handleMouseMove(e) {
        // Salva l'ultimo evento mouse
        lastMouseEvent = { x: e.clientX, y: e.clientY };
        
        // Se non c'è un tooltip attivo, ignora
        if (!tooltip || tooltip.style.display !== 'block' || !currentElement) {
            return;
        }
        
        const elementRect = currentElement.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        
        // Area di tolleranza
        const tolerance = 25;
        
        // Controlla se il mouse è vicino all'elemento
        const isNearElement = isNear(
            { x: e.clientX, y: e.clientY },
            elementRect,
            tolerance
        );
        
        // Controlla se il mouse è vicino al tooltip
        const isNearTooltip = isNear(
            { x: e.clientX, y: e.clientY },
            tooltipRect,
            tolerance
        );
        
        // Crea un corridoio virtuale tra elemento e tooltip
        const isInCorridor = isInPath(
            e.clientX, e.clientY,
            (elementRect.left + elementRect.right) / 2, 
            (elementRect.top + elementRect.bottom) / 2,
            (tooltipRect.left + tooltipRect.right) / 2, 
            (tooltipRect.top + tooltipRect.bottom) / 2,
            tolerance * 2.5
        );
        
        // Controlla se il mouse è vicino a un'altra icona commento
        const isNearAnotherIcon = isNearAnyCommentIcon(e.clientX, e.clientY);
        
        // Se il mouse è in un'area sicura, mantieni il tooltip visibile
        if (isNearElement || isNearTooltip || isInCorridor || isNearAnotherIcon) {
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            
            // Se siamo vicini a un'altra icona, impostiamo la transizione
            if (isNearAnotherIcon && !isNearElement && !isNearTooltip) {
                isTransitioning = true;
            }
        } else {
            // Se il mouse è fuori, inizia a nascondere
            startHideTooltip();
        }
    }
    
    // Verifica se il mouse è vicino a qualsiasi icona commento
    function isNearAnyCommentIcon(x, y) {
        if (!currentElement) return false;
        
        const tolerance = 35;
        const icons = document.querySelectorAll(".anilist-comment-icon");
        
        for (const icon of icons) {
            // Salta l'elemento corrente
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
    
    // Avvia il sistema di tooltip manager
    function init() {
        // Aggiungi listener globale per il movimento del mouse
        document.addEventListener("mousemove", handleMouseMove);
        
        return {
            // Mostra tooltip per un elemento
            show: function(element, username, mediaId) {
                startShowTooltip(element, username, mediaId);
            },
            
            // Indica l'intenzione di nascondere
            hide: function() {
                startHideTooltip();
            },
            
            // Forza la chiusura del tooltip
            forceHide: function() {
                hideTooltip();
            },
            
            // Aggiorna manualmente il tooltip
            refreshContent: async function() {
                if (!currentUsername || !currentMediaId) return;
                
                // Mostra il caricamento
                updateTooltipContent("Loading...");
                
                try {
                    // Fetch del nuovo commento
                    const comment = await fetchUserComment(currentUsername, currentMediaId);
                    
                    // Aggiorna la cache
                    const cacheKey = `${currentUsername}-${currentMediaId}`;
                    commentCache[cacheKey] = {
                        content: comment || '',
                        timestamp: Date.now()
                    };
                    
                    // Salva la cache
                    saveCache();
                    
                    // Aggiorna il contenuto
                    updateTooltipContent(comment);
                } catch (error) {
                    console.error("Error refreshing tooltip content:", error);
                    updateTooltipContent("Error refreshing content");
                }
            },
            
            // Cleanup di tutte le risorse
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
    
    // Crea o restituisci il singleton
    return {
        getInstance: function() {
            if (!instance) {
                instance = init();
            }
            return instance;
        }
    };
})();

// Funzione semplificata per configurare il listener per l'hover
function setupHoverListener(element, username, mediaId, cachedComment = null) {
    // Ottiene l'istanza del tooltip manager
    const tooltipManager = TooltipManager.getInstance();
    
    // Aggiunge l'evento mouseenter sull'elemento
    element.addEventListener("mouseenter", () => {
        tooltipManager.show(element, username, mediaId);
    });
    
    // Aggiunge l'evento mouseleave
    element.addEventListener("mouseleave", () => {
        // Leggero ritardo prima di nascondere per consentire il movimento al tooltip
        setTimeout(() => {
            tooltipManager.hide();
        }, 50);
    });
    
    // Restituisce una funzione di cleanup
    return function cleanup() {
        // Nastro dell'elemento con il listener
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

// Function to extract the anime ID from the URL
function extractMediaIdFromUrl() {
    // Check for anime URLs
    let urlMatch = window.location.pathname.match(/\/anime\/(\d+)/);
    if (urlMatch && urlMatch[1]) {
        return {
            id: parseInt(urlMatch[1]),
            type: 'ANIME'
        };
    }
    
    // Check for manga URLs
    urlMatch = window.location.pathname.match(/\/manga\/(\d+)/);
    if (urlMatch && urlMatch[1]) {
        return {
            id: parseInt(urlMatch[1]),
            type: 'MANGA'
        };
    }
    
    return null;
}

/**
 * Fetches a user's comment for a specific media from the Anilist API
 * Includes retry logic and special handling for current user
 */
async function fetchUserComment(username, mediaId) {
    const isCurrentUser = (username === currentUsername);
    
    if (FORCE_DEBUG) {
        console.log(`Fetch request for ${username} on media ${mediaId} (current user: ${isCurrentUser})`);
    }
    
    // Check the cache first
    const cacheKey = `${username}-${mediaId}`;
    if (commentCache[cacheKey]) {
        // Check if cache entry is still valid (not expired)
        const now = Date.now();
        
        if (typeof commentCache[cacheKey] === 'object' && 
            commentCache[cacheKey].timestamp &&
            (now - commentCache[cacheKey].timestamp) < CACHE_MAX_AGE) {
            
            if (FORCE_DEBUG) {
                console.log(`✓ Using valid cache for ${username}`, {
                    cached: new Date(commentCache[cacheKey].timestamp),
                    age: Math.round((now - commentCache[cacheKey].timestamp) / (60 * 1000)) + ' minutes',
                    content: commentCache[cacheKey].content.substring(0, 30) + 
                            (commentCache[cacheKey].content.length > 30 ? '...' : '')
                });
            }
            
            return commentCache[cacheKey].content;
        } else {
            if (FORCE_DEBUG) {
                console.log(`⚠ Cache expired for ${username}, fetching fresh data`);
                if (typeof commentCache[cacheKey] === 'object' && commentCache[cacheKey].timestamp) {
                    const age = (now - commentCache[cacheKey].timestamp) / (60 * 1000);
                    console.log(`Cache age: ${Math.round(age)} minutes, max age: ${CACHE_MAX_AGE / (60 * 1000)} minutes`);
                }
            }
        }
    } else if (FORCE_DEBUG) {
        console.log(`No cache entry for ${username} on media ${mediaId}`);
    }
    
    // If we're rate limited, use cached content even if expired
    if (isRateLimited && commentCache[cacheKey]) {
        if (FORCE_DEBUG) {
            console.log(`Using expired cache due to rate limiting for ${username}`);
        }
        return typeof commentCache[cacheKey] === 'object' ? 
            commentCache[cacheKey].content : commentCache[cacheKey];
    }
    
    // The query asks for both notes (comments) and status
    // Even if there's no score, as long as the user has added the media to their list
    // and written notes, this will return the comment
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
    
    // Use retry mechanism with exponential backoff
    let retryCount = 0;
    let delay = RETRY_DELAY_BASE;
    
    while (retryCount <= MAX_RETRIES) {
        try {
            // Add a small random delay to spread out requests and prevent API overload
            await new Promise(resolve => setTimeout(resolve, Math.random() * 200));
            
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
                
                // Handle rate limiting specifically
                if (status === 429) {
                    isRateLimited = true;
                    rateLimitResetTime = Date.now() + 300000; // 5 minute cooldown
                    throw new Error("Rate limit exceeded (HTTP 429)");
                }
                
                throw new Error(`HTTP error ${status}`);
            }
            
            const data = await response.json();
            
            // Check for errors in the response
            if (data.errors) {
                if (data.errors.some(e => e.message && e.message.toLowerCase().includes('rate'))) {
                    isRateLimited = true;
                    rateLimitResetTime = Date.now() + 300000; // 5 minute cooldown
                    throw new Error("Rate limit exceeded in response");
                }
                throw new Error(data.errors[0].message || "Unknown GraphQL error");
            }
            
            // Special debug logging for current user
            if (isCurrentUser && DEBUG) {
                console.log(`Current user API response:`, data);
                console.log(`Current user comment fetch result: "${data?.data?.MediaList?.notes || ''}"`);
            }
            
            // Extract and return the notes if available
            if (data.data && data.data.MediaList) {
                if (DEBUG) {
                    // Also log additional details to help debug
                    console.log(`User ${username} status for media ${mediaId}: ${data.data.MediaList.status}`);
                    console.log(`User ${username} score for media ${mediaId}: ${data.data.MediaList.score || 'No score'}`);
                    console.log(`User ${username} has notes: ${!!data.data.MediaList.notes}`);
                }
                return data.data.MediaList.notes || "";
            }
            
            return "";
        } catch (error) {
            // Use the current attempt number (1-based) for logging
            const currentAttempt = retryCount + 1;
            console.error(`API request error (attempt ${currentAttempt}/${MAX_RETRIES + 1}):`, error);
            
            // Add more detailed logging
            if (error.message && error.message.includes('429')) {
                console.warn('Rate limit hit, will retry later');
            }
            
            // Determine if this is a severe error that should trigger rate limiting
            const isSevereError = error.message && (
                error.message.includes('429') || 
                error.message.includes('rate limit') || 
                error.message.includes('too many requests')
            );
            
            // Mark as rate limited for severe errors
            if (isSevereError) {
                isRateLimited = true;
                rateLimitResetTime = Date.now() + 300000; // 5 minute cooldown
                
                // Update the UI with rate limit warning
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
                // Use longer delay for 500 errors (server issues)
                const serverError = error.message && error.message.includes('500');
                const waitTime = serverError ? delay * 2 : delay;
                
                // Wait with exponential backoff before retrying
                await new Promise(resolve => setTimeout(resolve, waitTime));
                delay *= RETRY_DELAY_FACTOR; // Increase delay for next retry
            } else {
                return ""; // Return empty string on failure to be less disruptive
            }
        }
    }
}

// Monitor URL changes
let lastUrl = location.href;

function handleUrlChange() {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
        if (DEBUG) console.log("URL change detected:", currentUrl);
        lastUrl = currentUrl;
        
        // Reset the extension state
        isInitialized = false;
        stopDetection();
        
        // Small delay to give the page time to start loading
        setTimeout(() => {
            startAfterCacheLoad();
        }, 100);
    }
}

function loadCacheAndInitialize() {
    if (!isExtensionContextValid()) return;
    
    try {
        chrome.storage.local.get(['commentCache'], function(result) {
            // Check context again inside the callback
            if (!isExtensionContextValid()) return;
            
            if (result.commentCache) {
                if (DEBUG) console.log("Comment cache loaded from storage:", Object.keys(result.commentCache).length, "items");
                
                // Filter out expired cache entries
                const now = Date.now();
                const validEntries = {};
                let expiredCount = 0;
                
                for (const [key, value] of Object.entries(result.commentCache)) {
                    if (typeof value === 'object' && value.timestamp && (now - value.timestamp) < CACHE_MAX_AGE) {
                        validEntries[key] = value;
                    } else if (typeof value === 'string' && value !== "__has_comment__") {
                        // Migrate old cache format to new format with timestamp
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
                    // Save the cleaned cache
                    if (isExtensionContextValid()) {
                        chrome.storage.local.set({commentCache: validEntries});
                    }
                }
            }
            
            // Start automatic cache cleanup timer
            startCacheCleanupTimer();
            
            // Initialize extension after cache load
            startAfterCacheLoad();
        });
    } catch (e) {
        console.error("Error loading cache:", e);
    }
}

// Configure the observer for URL changes
const urlObserver = new MutationObserver(() => {
    handleUrlChange();
});

// Start monitoring URL changes
urlObserver.observe(document, {subtree: true, childList: true});

// Add a listener for the popstate event (handles back/forward navigation)
window.addEventListener('popstate', () => {
    handleUrlChange();
});

// Listener for the visibilitychange event (user returns to the tab)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !isInitialized && isAnimePage) {
        if (DEBUG) console.log("User has returned to the page, checking Following section");
        checkForFollowingSection(extractMediaIdFromUrl());
    }
});

// Modified initialization code
document.addEventListener('DOMContentLoaded', () => {
    if (isExtensionContextValid()) {
        console.log("Content script loaded, starting extension");
        loadCacheAndInitialize();
    }
});

// Also start in case DOMContentLoaded has already been fired
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (isExtensionContextValid()) {
            loadCacheAndInitialize();
        }
    });
} else {
    if (isExtensionContextValid()) {
        loadCacheAndInitialize();
    }
}

// Function to start automatic cache cleanup timer
function startCacheCleanupTimer() {
    if (!isExtensionContextValid()) return;
    
    if (cacheCleanupTimer) {
        clearInterval(cacheCleanupTimer);
    }
    
    cacheCleanupTimer = setInterval(function() {
        if (isExtensionContextValid()) {
            cleanupExpiredCache();
        } else {
            // If context is invalid, clear the interval
            clearInterval(cacheCleanupTimer);
            cacheCleanupTimer = null;
        }
    }, CACHE_CLEANUP_INTERVAL);
}