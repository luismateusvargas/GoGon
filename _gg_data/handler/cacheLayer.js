// _gg_data/handler/cacheLayer.js - LRU Cache for Database Queries
// Project: GoGon (GG)

/**
 * Simple LRU (Least Recently Used) Cache implementation
 * Automatically evicts oldest entries when max size is reached
 */
class LRUCache {
    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    /**
     * Get a value from cache
     * @param {string} key - Cache key
     * @returns {any} Cached value or undefined
     */
    get(key) {
        if (!this.cache.has(key)) return undefined;
        
        // Move to end (mark as recently used)
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        
        return value;
    }

    /**
     * Set a value in cache
     * @param {string} key - Cache key
     * @param {any} value - Value to cache
     */
    set(key, value) {
        // Delete if exists (to re-add at end)
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        
        // Add to end
        this.cache.set(key, value);
        
        // Evict oldest if over max size
        if (this.cache.size > this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
    }

    /**
     * Check if key exists in cache
     * @param {string} key - Cache key
     * @returns {boolean}
     */
    has(key) {
        return this.cache.has(key);
    }

    /**
     * Clear all cache entries
     */
    clear() {
        this.cache.clear();
    }

    /**
     * Get cache statistics
     * @returns {object} Stats object with size and max size
     */
    stats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            usage: `${((this.cache.size / this.maxSize) * 100).toFixed(1)}%`
        };
    }
}

// Create separate caches for different data types
const creatureCache = new LRUCache(500); // Frequently accessed
const itemCache = new LRUCache(1000);    // Very frequently accessed
const realmCache = new LRUCache(300);    // Moderately accessed

/**
 * Get cache statistics for all caches
 * @returns {object} Combined stats for all caches
 */
export function getCacheStats() {
    return {
        creatures: creatureCache.stats(),
        items: itemCache.stats(),
        realms: realmCache.stats(),
        total: {
            size: creatureCache.cache.size + itemCache.cache.size + realmCache.cache.size,
            maxSize: creatureCache.maxSize + itemCache.maxSize + realmCache.maxSize
        }
    };
}

/**
 * Clear all caches (useful for testing or manual refresh)
 */
export function clearAllCaches() {
    creatureCache.clear();
    itemCache.clear();
    realmCache.clear();
    console.log('[GG_Cache] All caches cleared');
}

// Export cache instances
export { creatureCache, itemCache, realmCache };
