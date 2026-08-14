import type { PropsWithChildren } from 'react';
import { Modal, StyleSheet, View } from 'react-native';

import { PolicySupportHub } from './hub';
import { usePolicySupport } from './provider';

export function PolicySupportBoundary({ children }: PropsWithChildren) {
  const policySupport = usePolicySupport();
  return (
    <>
      <View
        accessibilityElementsHidden={policySupport.request !== null}
        importantForAccessibility={policySupport.request === null ? 'auto' : 'no-hide-descendants'}
        pointerEvents={policySupport.request === null ? 'auto' : 'none'}
        style={styles.application}
      >
        {children}
      </View>
      <Modal
        animationType="slide"
        onRequestClose={policySupport.close}
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        transparent={false}
        visible={policySupport.request !== null}
      >
        {policySupport.request === null ? null : (
          <View accessibilityViewIsModal style={styles.modal}>
            <PolicySupportHub
              key={policySupport.request.id}
              onExit={policySupport.close}
              request={policySupport.request}
            />
          </View>
        )}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  application: { flex: 1 },
  modal: { flex: 1 },
});
