import * as ImagePicker from 'expo-image-picker';

import { SYSTEM_IMAGE_PICKER_OPTIONS } from './image-picker-policy';

export { SYSTEM_IMAGE_PICKER_OPTIONS } from './image-picker-policy';

export type SystemImagePickerResult = Awaited<
  ReturnType<typeof ImagePicker.launchImageLibraryAsync>
>;

/** Opens the operating system library picker. Camera and video flows are excluded. */
export function pickSingleImageFromSystemLibrary() {
  return ImagePicker.launchImageLibraryAsync(SYSTEM_IMAGE_PICKER_OPTIONS);
}
