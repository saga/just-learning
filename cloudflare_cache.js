// --- Helper function to generate SHA-256 hash ---
async function generateHash(data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (!buffer || buffer.byteLength === 0) {
      return 'emptybody'; // Handle empty body case explicitly
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  // Convert ArrayBuffer to hex string
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 生成缓存键的函数 (支持 POST)
 * @param {Request} request - The original request.
 * @param {Request} requestClone - A clone of the request used for reading the body without consuming the original.
 * @returns {Promise<string>} - The cache key.
 */
async function generateCacheKey(request, requestClone) {
  const url = new URL(request.url);
  let key = `${request.method}:${url.toString()}`;

  // If it's a POST request, include a hash of the body in the key
  if (request.method === 'POST') {
    try {
      // Read the body from the clone. Use arrayBuffer for consistency,
      // text() might alter content based on encoding assumptions.
      const bodyBuffer = await requestClone.arrayBuffer(); // Reads the body from the clone
      if (bodyBuffer && bodyBuffer.byteLength > 0) {
          const bodyHash = await generateHash(bodyBuffer);
          key += `:bodyHash=${bodyHash}`;
      } else {
          key += ':bodyHash=emptybody';
      }
    } catch (e) {
      console.error("Error reading request body for cache key:", e);
      // Fallback or decide how to handle body read errors
      key += ':bodyHash=readerror';
    }
  }
  // Optional: Hash the final key string if it gets too long or contains difficult characters
  // key = await generateHash(key);
  return key;
}


// --- Constants ---
const DEFAULT_CACHE_TTL_SECONDS = 360000; // Default 1 hour
const CACHE_CONTROL_HEADER = 'cf-cache-control'; // Custom header

export default {
  async fetch(request, env, ctx) {
    // --- Configuration Check ---
    const originApiUrl = env.ORIGIN_API_URL;
    if (!originApiUrl) {
      return new Response("Origin API URL not configured", { status: 500 });
    }
    if (!env.API_CACHE_BUCKET) {
      return new Response("R2 Bucket not bound", { status: 500 });
    }

    // --- Clone request early for potential body reading ---
    // We need a clone because reading the body consumes it,
    // and we might need the original body to forward to the origin.
    const requestCloneForKey = request.clone();

    // --- Generate Cache Key (Now potentially async and reads body for POST) ---
    const cacheKey = await generateCacheKey(request, requestCloneForKey);
    const url = new URL(request.url);

    // --- Cache Control ---
    const bypassCache = request.headers.get(CACHE_CONTROL_HEADER)?.toLowerCase() === 'no-cache';
    const forceCache = request.headers.get(CACHE_CONTROL_HEADER)?.toLowerCase() === 'force-cache'; // Optional: Header to force caching even if normally disallowed


    // --- Determine if method is cacheable ---
    // CAREFUL: Only include 'POST' if you are ABSOLUTELY SURE it's safe for your use case.
    const isCacheableMethod = (request.method === 'GET' || request.method === 'POST');

    // --- 1. Try to get from R2 Cache ---
    let cachedResponseData = null;
    if (!bypassCache && isCacheableMethod) {
      try {
        const object = await env.API_CACHE_BUCKET.get(cacheKey);
        if (object !== null) {
          cachedResponseData = await object.json();

          const expiration = object.customMetadata?.expiration;
          if (expiration && new Date().getTime() > parseInt(expiration)) {
              console.log(`Cache expired for key: ${cacheKey}`);
              cachedResponseData = null;
              ctx.waitUntil(env.API_CACHE_BUCKET.delete(cacheKey));
          } else {
              console.log(`Cache HIT for key: ${cacheKey}`);
              const headers = new Headers(cachedResponseData.headers);
              headers.set('X-Cache-Status', 'HIT');
              headers.set('X-Cache-Key', cacheKey);

              // Body might be stored as string or need parsing depending on how you stored it
              let bodyContent = cachedResponseData.body;
              // If body was stored as an object/array, stringify it again.
              if (typeof bodyContent !== 'string') {
                  bodyContent = JSON.stringify(bodyContent);
              }


              return new Response(bodyContent, {
                status: cachedResponseData.status,
                headers: headers,
              });
          }
        } else {
          console.log(`Cache MISS for key: ${cacheKey}`);
        }
      } catch (e) {
        console.error(`Error reading from R2 cache: ${e}`);
      }
    } else {
      console.log(`Skipping cache lookup for method ${request.method} or bypass requested.`);
    }

    // --- 2. Cache Miss or Non-Cacheable Method: Forward to Origin ---
    console.log(`Forwarding request to origin: ${originApiUrl}${url.pathname}${url.search}`);
    const originRequestUrl = `${originApiUrl}${url.pathname}${url.search}`;

    // IMPORTANT: Use the ORIGINAL request object here, as its body stream hasn't been consumed yet.
    // If you modified headers or other properties, ensure you use a clone THAT HASN'T had its body read.
    const originRequest = new Request(originRequestUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body, // Pass the original body stream
      redirect: 'manual',
    });
    originRequest.headers.delete('host'); // Let fetch handle Host

    let originResponse;
    try {
        originResponse = await fetch(originRequest);
    } catch (e) {
        console.error(`Error fetching from origin: ${e}`);
        return new Response(`Failed to fetch from origin: ${e.message}`, { status: 502 });
    }

    // Clone responses for caching and returning
    const responseToCache = originResponse.clone();
    const responseToReturn = originResponse.clone();

    // --- 3. Try to Cache the Origin Response ---
    const cacheControl = responseToCache.headers.get('Cache-Control')?.toLowerCase();
    const pragma = responseToCache.headers.get('Pragma')?.toLowerCase();

    // Modify shouldCache condition to potentially include POST
    const shouldCache =
        (isCacheableMethod || forceCache) && // Allow cacheable methods or if forced
        responseToCache.status >= 200 && responseToCache.status < 300 &&
        (!cacheControl || (!cacheControl.includes('no-cache') && !cacheControl.includes('no-store'))) &&
        (!pragma || !pragma.includes('no-cache'));

    if (shouldCache && !bypassCache) {
        let ttl = DEFAULT_CACHE_TTL_SECONDS;
        const customTtlHeader = request.headers.get(CACHE_CONTROL_HEADER);
        if (customTtlHeader && customTtlHeader.startsWith('max-age=')) {
            ttl = parseInt(customTtlHeader.split('=')[1]) || DEFAULT_CACHE_TTL_SECONDS;
        } else if (cacheControl && cacheControl.includes('max-age=')) {
            const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
            if (maxAgeMatch) { ttl = parseInt(maxAgeMatch[1]); }
        }
        console.log(`Attempting to cache response for key: ${cacheKey} with TTL: ${ttl} seconds`);

        try {
            // Read body from the response clone
            // Decide how to store the body. Storing as text is often safer
            // unless you know it's always JSON or need ArrayBuffer.
            const bodyText = await responseToCache.text();

            const headersToStore = {};
            for (const [key, value] of responseToCache.headers.entries()) {
                headersToStore[key] = value;
            }

            const dataToStore = {
                body: bodyText, // Store body as text
                status: responseToCache.status,
                headers: headersToStore,
            };

            const expirationTimestamp = new Date().getTime() + ttl * 1000;

            ctx.waitUntil(
                env.API_CACHE_BUCKET.put(cacheKey, JSON.stringify(dataToStore), {
                    customMetadata: {
                        expiration: expirationTimestamp.toString(),
                    },
                    // expirationTtl: ttl // Alternative: Let R2 handle deletion
                })
                .then(() => console.log(`Successfully cached response for key: ${cacheKey}`))
                .catch(e => console.error(`Failed to cache response for key ${cacheKey}: ${e}`))
            );
        } catch (e) {
            console.error(`Failed to read response body for caching: ${e}`);
        }
    } else {
        console.log(`Response for key ${cacheKey} will not be cached (Method: ${request.method}, Status: ${responseToCache.status}, CacheableMethod: ${isCacheableMethod}, Cache-Control: ${cacheControl}, Pragma: ${pragma}, Bypass: ${bypassCache})`);
    }

    // --- 4. Return the Response (from Origin) ---
    const finalResponseHeaders = new Headers(responseToReturn.headers);
    finalResponseHeaders.set('X-Cache-Status', 'MISS');
    finalResponseHeaders.set('X-Cache-Key', cacheKey); // Good for debugging

    return new Response(responseToReturn.body, {
        status: responseToReturn.status,
        statusText: responseToReturn.statusText,
        headers: finalResponseHeaders,
    });
  },
};
