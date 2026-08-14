import { useRouter } from 'expo-router';
import { useLayoutEffect } from 'react';

export default function ShareBlockIngressScreen() {
  const router = useRouter();

  useLayoutEffect(() => {
    router.replace('/public-share-block');
  }, [router]);

  return null;
}
