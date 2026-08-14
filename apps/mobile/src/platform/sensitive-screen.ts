import * as ScreenCapture from 'expo-screen-capture';
import { Platform } from 'react-native';

const PROTECTION_KEY = 'danyeodam-recovery-code';
let holderCount = 0;
let operationQueue: Promise<void> = Promise.resolve();

function enqueue(operation: () => Promise<void>): Promise<void> {
  operationQueue = operationQueue.then(operation, operation);
  return operationQueue;
}

async function enableProtection(): Promise<void> {
  try {
    await ScreenCapture.preventScreenCaptureAsync(PROTECTION_KEY);
    if (Platform.OS === 'ios') {
      await ScreenCapture.enableAppSwitcherProtectionAsync(1);
    }
  } catch (error) {
    await disableProtection();
    throw error;
  }
}

async function disableProtection(): Promise<void> {
  await Promise.allSettled([
    ScreenCapture.allowScreenCaptureAsync(PROTECTION_KEY),
    ...(Platform.OS === 'ios'
      ? [ScreenCapture.disableAppSwitcherProtectionAsync()]
      : []),
  ]);
}

export async function acquireSensitiveScreenProtection(): Promise<() => void> {
  holderCount += 1;
  try {
    if (holderCount === 1) {
      await enqueue(enableProtection);
    } else {
      await operationQueue;
    }
  } catch (error) {
    holderCount = Math.max(0, holderCount - 1);
    throw error;
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    holderCount = Math.max(0, holderCount - 1);
    if (holderCount === 0) {
      void enqueue(disableProtection);
    }
  };
}
