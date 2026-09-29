// _gg_data/handler/mediaUrl.js - Fallen Sword image URLs that Discord can load.
// cdn.fallensword.com now answers every request with a Cloudflare challenge (HTTP 403), so Discord's
// image proxy drops embeds that point there. The same paths are still served by cdn2.fallensword.com.
// The fsdatabase seed and the guide still hand out cdn.fallensword.com (items over plain http).

export const MEDIA_BASE = 'https://cdn2.fallensword.com/';
const MEDIA_HOST = /^(?:https?:)?\/\/cdn2?\.fallensword\.com\//i;

/** The URL on the working media host; anything that is not a Fallen Sword CDN URL is returned as is. */
export function canonicalImageUrl(url) {
    return typeof url === 'string' ? url.replace(MEDIA_HOST, MEDIA_BASE) : url;
}
