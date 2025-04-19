/**
 * Anilist Hover Comments - Content Script
 *
 * This script identifies user comments on Anilist anime/manga pages and displays
 * an icon that shows comments when hovered over.
 *
 * GitHub: https://github.com/rikymarche-ctrl/anilist-extension
 */
console.log("Anilist Hover Comments: Loaded!");

// Configuration constants
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const MAX_REQUESTS_PER_MINUTE = 10; // Conservative to avoid rate limiting
const RATE_LIMIT_DURATION = 60000; // 1 minute in milliseconds
const BATCH_DELAY = 200; // Delay between API requests in ms

// Global state
let commentCache = {};
let isInitialized = false;
let isRateLimited = false;
let requestsInLastMinute = 0;
let lastMinuteReset = Date.now();
let lastUrl = location.href;
let lastMediaId = null;
let apiQueue = [];
let processingQueue = false;

// Load FontAwesome for icons
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

// Main initialization function
function initialize() {
    console.log("Initializing extension");
    loadFontAwesome();

    const media = extractMediaIdFromUrl();
    if (!media) return;

    if (isInitialized) return;

    // Reset state
    resetState();

    // Forza il caricamento della cache
    loadCacheFromStorage();

    // Find the following section
    findFollowingSection(media.id);

    // Set up additional configuration for SPA pages
    observeUrlChanges();

    // Repeat checks a few times for pages with slow loading
    setTimeout(() => {
        if (!isInitialized) findFollowingSection(media.id);
    }, 500);

    setTimeout(() => {
        if (!isInitialized) findFollowingSection(media.id);
    }, 1500);
}

// Find the following section and process users
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

    // Process each user
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

// Reset state
function resetState() {
    const tooltip = document.getElementById('anilist-tooltip');
    if (tooltip) tooltip.remove();

    isRateLimited = false;
    requestsInLastMinute = 0;
    lastMinuteReset = Date.now();
    apiQueue = [];
    processingQueue = false;
}

// Observe URL changes for SPAs
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

// Check user comment and add icon if necessary
async function checkUserComment(entry, username, mediaId) {
    // Check if the icon already exists
    if (entry.querySelector('.comment-icon-column')) {
        return;
    }

    // Cache key
    const cacheKey = `${username}-${mediaId}`;

    // Check cache first
    let foundInCache = false;
    let hasComment = false;

    if (commentCache[cacheKey]) {
        const cache = commentCache[cacheKey];
        const now = Date.now();

        // If cache still valid, check if there's a comment
        if (cache.timestamp && (now - cache.timestamp) < CACHE_MAX_AGE) {
            foundInCache = true;
            if (cache.content && cache.content.trim() !== '') {
                hasComment = true;
                addCommentIcon(entry, username, mediaId);
            }
        }
    }

    // Se non abbiamo trovato nella cache, o la cache è scaduta, fai richiesta API
    if (!foundInCache) {
        queueApiRequest(entry, username, mediaId);
    }
}

// Queue API requests to control request rate
function queueApiRequest(entry, username, mediaId) {
    apiQueue.push({ entry, username, mediaId });

    if (!processingQueue) {
        processApiQueue();
    }
}

// Process API queue with controlled pacing
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

        requestsInLastMinute++;

        // Fetch comment
        const comment = await fetchUserComment(request.username, request.mediaId);

        // Update cache
        const cacheKey = `${request.username}-${request.mediaId}`;
        commentCache[cacheKey] = {
            content: comment || '',
            timestamp: Date.now()
        };

        // Importante: Aggiungi SEMPRE l'icona, anche se il commento è vuoto
        // Questo risolve il problema quando il commento non c'è ma dovremmo comunque
        // permettere l'interazione con l'icona
        addCommentIcon(request.entry, request.username, request.mediaId);

        // Save cache periodically
        if (Object.keys(commentCache).length % 5 === 0) {
            trySaveCacheToStorage();
        }

        // Process next request after delay
        setTimeout(processApiQueue, BATCH_DELAY);

    } catch (error) {
        // Process next request after delay, senza loggare errori
        setTimeout(processApiQueue, BATCH_DELAY);
    }
}

// Add comment icon to user entry
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
    iconCol.style.right = '100px';  // Moved further left

    // Append to entry
    entry.appendChild(iconCol);

    // Set up hover listener
    setupHoverListener(iconCol, username, mediaId);
}

// Tooltip management
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
        this.hideTimer = null;
        this.currentElement = null;
        this.currentUsername = null;
        this.currentMediaId = null;

        // Add global mouse move listener
        document.addEventListener('mousemove', this.handleMouseMove.bind(this));
    }

    show(element, username, mediaId) {
        // Remove active class from ALL icons first to fix highlighting persistence
        document.querySelectorAll('.anilist-comment-icon').forEach(icon => {
            icon.classList.remove('active-comment');
        });

        // Cancel hide timer if active
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }

        this.currentElement = element;
        this.currentUsername = username;
        this.currentMediaId = mediaId;

        // Get or create tooltip
        const tooltip = this.getTooltip();

        // Force visibility
        tooltip.style.opacity = '0';
        tooltip.style.display = 'block';

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

            // Load comment
            this.loadComment(username, mediaId);
        }, 50);
    }

    hide() {
        if (!this.tooltip || this.hideTimer) return;

        this.hideTimer = setTimeout(() => {
            if (this.tooltip) {
                this.tooltip.style.opacity = '0';

                setTimeout(() => {
                    this.tooltip.style.display = 'none';

                    // Reset ALL icon highlights
                    document.querySelectorAll('.anilist-comment-icon').forEach(icon => {
                        icon.classList.remove('active-comment');
                    });

                    this.currentElement = null;
                    this.currentUsername = null;
                    this.currentMediaId = null;
                    this.hideTimer = null;
                }, 300); // Match the CSS transition time
            }
        }, 100);
    }

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

                // Add event listeners
                this.tooltip.addEventListener('mouseenter', () => {
                    if (this.hideTimer) {
                        clearTimeout(this.hideTimer);
                        this.hideTimer = null;
                    }
                });

                this.tooltip.addEventListener('mouseleave', () => {
                    this.hide();
                });
            }
        }

        return this.tooltip;
    }

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

        // Set tooltip position
        tooltip.style.transition = "none";
        tooltip.style.left = posX + 'px';
        tooltip.style.top = posY + 'px';

        // Re-enable transitions
        setTimeout(() => {
            tooltip.style.transition = "opacity 0.3s ease";
        }, 20);
    }

    async loadComment(username, mediaId) {
        // Cache key
        const cacheKey = `${username}-${mediaId}`;

        // Try cache first
        let comment = null;
        let cacheIsValid = false;
        const now = Date.now();

        // Tentativo di caricamento dalla cache
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
                // Rate limit check
                const now = Date.now();
                if (now - lastMinuteReset > RATE_LIMIT_DURATION) {
                    requestsInLastMinute = 0;
                    lastMinuteReset = now;
                }

                if (requestsInLastMinute >= MAX_REQUESTS_PER_MINUTE) {
                    throw new Error("Rate limit reached");
                }

                requestsInLastMinute++;

                // Fetch with timeout
                const fetchPromise = fetchUserComment(username, mediaId);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Request timed out")), 8000)
                );

                const freshComment = await Promise.race([fetchPromise, timeoutPromise]);

                // Update cache
                commentCache[cacheKey] = {
                    content: freshComment || '',
                    timestamp: Date.now()
                };

                // Update content
                this.updateTooltipContent(freshComment, username, mediaId);

                // Try to save to storage
                trySaveCacheToStorage();

                // Reset button
                refreshButton.innerHTML = '<i class="fa-solid fa-check"></i> Updated';
                setTimeout(() => {
                    refreshButton.innerHTML = '<i class="fa-solid fa-sync"></i> Refresh';
                    refreshButton.disabled = false;
                }, 2000);
            } catch (error) {
                // Error handling
                refreshButton.innerHTML = '<i class="fa-solid fa-exclamation-circle"></i> Error';
                refreshButton.classList.add('error');

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

    handleMouseMove(e) {
        // Skip if tooltip not active
        if (!this.tooltip || this.tooltip.style.display !== 'block' || !this.currentElement) {
            return;
        }

        const elementRect = this.currentElement.getBoundingClientRect();
        const tooltipRect = this.tooltip.getBoundingClientRect();

        // Increase tolerance for better usability
        const tolerance = 40;

        const isNearElement =
            e.clientX >= elementRect.left - tolerance &&
            e.clientX <= elementRect.right + tolerance &&
            e.clientY >= elementRect.top - tolerance &&
            e.clientY <= elementRect.bottom + tolerance;

        const isNearTooltip =
            e.clientX >= tooltipRect.left - tolerance &&
            e.clientX <= tooltipRect.right + tolerance &&
            e.clientY >= tooltipRect.top - tolerance &&
            e.clientY <= tooltipRect.bottom + tolerance;

        // Keep visible in safe area
        if (isNearElement || isNearTooltip) {
            if (this.hideTimer) {
                clearTimeout(this.hideTimer);
                this.hideTimer = null;
            }
        } else {
            // Start hiding
            this.hide();
        }
    }
}

// Set up hover listener with improved event handling
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

    // Icon specific hover (for the animation effect)
    element.addEventListener("mouseenter", (e) => {
        e.stopPropagation();
        // Usare un timeout più breve ma comunque garantire che il tooltip si apra
        setTimeout(() => tooltipManager.show(element, username, mediaId), 5);
    });

    element.addEventListener("mouseleave", (e) => {
        e.stopPropagation();
        // Piccolo delay per evitare flickering
        setTimeout(() => {
            tooltipManager.hide();
        }, 50);
    });

    // Add click behavior too for better reliability
    element.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        tooltipManager.show(element, username, mediaId);
    });
}

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

// Fetch user comment - utilizzato per la scansione iniziale
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

        // Se la risposta non è ok, restituisci stringa vuota
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

        // Se ci sono errori, restituisci stringa vuota
        if (data.errors) {
            return "";
        }

        // Success
        const notes = data.data?.MediaList?.notes || "";
        return notes;
    } catch (error) {
        // Per qualsiasi errore, restituisci stringa vuota
        return "";
    }
}

// Extract media ID from URL
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

// Improved cache storage with error handling - APPROCCIO ALTERNATIVO
function trySaveCacheToStorage() {
    // Approccio con localStorage per evitare l'errore "Extension context invalidated"
    try {
        localStorage.setItem('anilist_comment_cache', JSON.stringify(commentCache));
    } catch (e) {
        // Ignora silenziosamente
    }
}

// Load cache from storage with fallback - APPROCCIO ALTERNATIVO
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
                // Se il JSON è corrotto, inizializziamo una cache vuota
                commentCache = {};
            }
        }
    } catch (e) {
        // Se fallisce anche localStorage, inizializziamo una cache vuota
        commentCache = {};
    }
    return false;
}

// Initialization events
document.addEventListener('DOMContentLoaded', () => {
    // Carica cache appena possibile
    loadCacheFromStorage();
    setTimeout(initialize, 150);
});

// Fallback for pages that load slowly
window.addEventListener('load', () => {
    if (!isInitialized) {
        // Assicurati che la cache sia caricata prima di inizializzare
        loadCacheFromStorage();
        setTimeout(initialize, 300);
    }
});

// Cache periodic save
let saveInterval = setInterval(() => {
    try {
        if (Object.keys(commentCache).length > 0) {
            trySaveCacheToStorage();
        }
    } catch (e) {
        // Ignora silenziosamente
    }
}, 300000); // Every 5 minutes

// Clean up on unload
window.addEventListener('beforeunload', () => {
    clearInterval(saveInterval);
    if (Object.keys(commentCache).length > 0) {
        trySaveCacheToStorage();
    }
});

// Immediate initialization after cache load
loadCacheFromStorage();
setTimeout(initialize, 50);