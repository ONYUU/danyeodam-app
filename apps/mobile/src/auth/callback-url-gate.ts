export type CallbackUrlGate = {
  take(url: string | null): string | null;
};

export function createCallbackUrlGate(): CallbackUrlGate {
  let handled = false;

  return {
    take(url) {
      if (handled || url === null) {
        return null;
      }
      handled = true;
      return url;
    },
  };
}
