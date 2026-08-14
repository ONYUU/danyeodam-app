import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('personal-card photo UI privacy boundary', () => {
  it('renders authenticated photos from an in-memory object URL and revokes it', async () => {
    const [source, resourceSource] = await Promise.all([
      readFile(new URL('./use-owned-photo.ts', import.meta.url), 'utf8'),
      readFile(new URL('./owned-photo-resource.ts', import.meta.url), 'utf8'),
    ]);

    expect(source).toContain('loadOwnedPersonalCardPhoto');
    expect(source).toContain('createOwnedPhotoLoadAttempt()');
    expect(source).toContain('attempt.publish(blob)');
    expect(source).toContain('attempt.release()');
    expect(resourceSource).toContain('URL.createObjectURL');
    expect(resourceSource).toContain('URL.revokeObjectURL');
    expect(resourceSource).toContain("from '@/api/native-blob'");
    expect(source).not.toMatch(/Authorization|access[_A-Z]?token/iu);
  });

  it('binds add and read flows to collection acquisition and personal-card ids', async () => {
    const [collectionSource, recordSource] = await Promise.all([
      readFile(
        new URL('../../components/collection-item-card.tsx', import.meta.url),
        'utf8',
      ),
      readFile(new URL('./record.tsx', import.meta.url), 'utf8'),
    ]);

    expect(collectionSource).toContain(
      '<PersonalCardPhotoPanel acquisitionId={item.acquisition.id} />',
    );
    expect(collectionSource).toContain(
      '<PersonalCardPhotoRecord personalCard={item.personalCard} />',
    );
    expect(recordSource).toContain('personalCardId={input.personalCard.id}');
    expect(recordSource).toContain('photoPath={input.personalCard.photoPath}');
  });

  it('keeps source bytes only in the generation-bound retry coordinator and wipes them', async () => {
    const source = await readFile(new URL('./coordinator.ts', import.meta.url), 'utf8');

    expect(source).toContain('photo.bytes.fill(0)');
    expect(source).toContain('isSameSessionBindingGeneration');
    expect(source).not.toMatch(/AsyncStorage|SecureStore|writeAsString|base64/iu);
  });

  it('uses the Expo 57 native Response.blob fallback and blob URL implementation', async () => {
    const [responseSource, urlSource] = await Promise.all([
      readFile(new URL('../../../node_modules/expo/src/winter/fetch/FetchResponse.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../node_modules/expo/src/winter/url.ts', import.meta.url), 'utf8'),
    ]);

    expect(responseSource).toContain('return createReactNativeBlobAsync(buffer, type);');
    expect(urlSource).toContain('blob.data!.blobId');
    expect(urlSource).toContain('URL.revokeObjectURL = function revokeObjectURL');
  });

  it('re-encodes a bounded JPEG and deletes its app cache file before upload', async () => {
    const [selectionSource, reencodeSource, temporarySource] = await Promise.all([
      readFile(new URL('./selection-native.ts', import.meta.url), 'utf8'),
      readFile(new URL('./reencode.ts', import.meta.url), 'utf8'),
      readFile(new URL('./temporary-file.ts', import.meta.url), 'utf8'),
    ]);

    expect(selectionSource).toContain('ImageManipulator.manipulate(uri)');
    expect(selectionSource).toContain('jpegFormat: SaveFormat.JPEG');
    expect(selectionSource).toContain('readTemporaryImageBytesAndDelete(new File(uri))');
    expect(selectionSource).toContain('deleteOwnedImagePickerCacheFile(');
    expect(selectionSource).toContain('cacheUri: Paths.cache.uri');
    expect(reencodeSource).toContain('context.resize(input.resize)');
    expect(reencodeSource).toContain('compress: PERSONAL_CARD_JPEG_QUALITY');
    expect(reencodeSource).toContain("contentType: 'image/jpeg'");
    expect(temporarySource).toContain('return await file.bytes()');
    expect(temporarySource).toContain('file.delete()');
  });

  it('uses fresh native JPEG encoders instead of copying source EXIF blocks', async () => {
    const [iosSource, androidSource] = await Promise.all([
      readFile(
        new URL(
          '../../../node_modules/expo-image-manipulator/ios/ImageManipulatorUtils.swift',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL(
          '../../../node_modules/expo-image-manipulator/android/src/main/java/expo/modules/imagemanipulator/ImageManipulatorModule.kt',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);

    expect(iosSource).toContain('image.jpegData(compressionQuality: compression)');
    expect(androidSource).toContain(
      'resultBitmap.compress(compressFormat, compression, fileOut)',
    );
  });

  it('shows server-current policy documents and explicit acceptance controls', async () => {
    const [source, panelSource] = await Promise.all([
      readFile(
        new URL('./policy-acceptance-panel.tsx', import.meta.url),
        'utf8',
      ),
      readFile(new URL('./panel.tsx', import.meta.url), 'utf8'),
    ]);

    expect(source).toContain('getCurrentPolicies(controller.signal)');
    expect(source).toContain('selectCurrentConsentPolicies(policies, locale)');
    expect(source).toContain('policy.documents[locale]');
    expect(source).toContain('document.sha256');
    expect(source).toContain('document.url');
    expect(source).toContain('accessibilityRole="checkbox"');
    expect(source).toContain('acceptCurrentPolicies({');
    expect(source).toContain('input.onAccepted()');
    expect(panelSource).toContain("state.failure === 'policy_required'");
    expect(panelSource).toContain('<PersonalCardPolicyAcceptancePanel');
    expect(panelSource).toContain('onAccepted={() => void save()}');
  });

  it('hides the accepted deletion immediately and refreshes collection state', async () => {
    const [recordSource, deleteSource] = await Promise.all([
      readFile(new URL('./record.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./delete-panel.tsx', import.meta.url), 'utf8'),
    ]);

    expect(recordSource).toContain('setHiddenAfterAcceptedDelete(true)');
    expect(recordSource).toContain('refreshCollection()');
    expect(deleteSource).toContain('coordinator.hasPendingRetry()');
    expect(deleteSource).toContain('personalCardId: input.personalCardId');
  });
});
