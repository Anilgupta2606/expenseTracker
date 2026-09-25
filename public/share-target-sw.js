/* Share sheet (Android): the system POSTs the shared files to ./share-target.
   Keep them in a cache and open the app's Upload page, which reads them. */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || !url.pathname.endsWith('/share-target')) return;
  event.respondWith((async () => {
    const form = await event.request.formData();
    const cache = await caches.open('shared-statements');
    let i = 0;
    for (const file of form.getAll('statements')) {
      if (!(file instanceof File)) continue;
      const key = new URL(`./shared/${Date.now()}-${i++}?name=${encodeURIComponent(file.name)}`, self.registration.scope);
      await cache.put(key, new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } }));
    }
    return Response.redirect(new URL('./#upload-shared', self.registration.scope).href, 303);
  })());
});
