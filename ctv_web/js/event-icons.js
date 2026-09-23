/* Shared, scalable event symbols for camera fields and recording segments. */
window.CtvEventIcons = (() => {
  const paths = {
    person: '<circle cx="12" cy="5" r="3"/><path d="M6 21v-5m12 5v-5M8 21v-8H5l2-4h10l2 4h-3v8"/>',
    vehicle: '<path d="m5 6-3 7v6h3v-3h14v3h3v-6l-3-7zM2 13h20M6 6h12"/><path d="M6 13v3m12-3v3"/>',
    animal: '<ellipse cx="12" cy="16" rx="6" ry="4"/><ellipse cx="5" cy="9" rx="2" ry="3"/><ellipse cx="10" cy="5" rx="2" ry="3"/><ellipse cx="16" cy="5" rx="2" ry="3"/><ellipse cx="21" cy="10" rx="2" ry="3"/>',
    motion: '<path d="M3 5h6M2 10h5M1 15h4M9 21l4-6-3-5 4-4 4 4h4M13 15l6 6"/><circle cx="17" cy="3" r="2"/>',
    doorbell: '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4M12 2v2"/>'
  };
  return { svg(kind) { return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[kind] || ''}</svg>`; } };
})();
