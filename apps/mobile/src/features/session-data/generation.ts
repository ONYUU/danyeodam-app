export type SessionBindingGeneration = Readonly<{
  authToken: symbol;
  bindingVersion: number;
  id: number;
}>;

export function isSameSessionBindingGeneration(
  left: SessionBindingGeneration,
  right: SessionBindingGeneration,
): boolean {
  return left.authToken === right.authToken
    && left.bindingVersion === right.bindingVersion;
}

export function createSessionBindingGenerationController() {
  const authToken = Symbol('session-auth-generation');
  let bindingVersion = 0;
  let current: SessionBindingGeneration = Object.freeze({
    authToken,
    bindingVersion,
    id: 0,
  });

  return {
    current(): SessionBindingGeneration {
      return current;
    },
    rotateBinding(): SessionBindingGeneration {
      bindingVersion += 1;
      current = Object.freeze({
        authToken,
        bindingVersion,
        id: bindingVersion,
      });
      return current;
    },
    isCurrent(candidate: SessionBindingGeneration): boolean {
      return isSameSessionBindingGeneration(candidate, current);
    },
  };
}

export type SessionBindingGenerationController = ReturnType<
  typeof createSessionBindingGenerationController
>;
