export function closeNativeBlobIfSupported(blob: Blob): void {
  // React Native Blob exposes close() for native-store deallocation. Web Blob
  // does not, so use the runtime method only when it exists.
  const close = Reflect.get(blob, 'close');
  if (typeof close === 'function') {
    Reflect.apply(close, blob, []);
  }
}
