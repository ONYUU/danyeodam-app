const {
  AndroidConfig,
  withAndroidManifest,
  withInfoPlist,
} = require('expo/config-plugins');

const IOS_MARKER_KEY = 'DanyeodamBuildSourceCommitSha';
const ANDROID_MARKER_NAME = 'kr.danyeodam.app.BUILD_SOURCE_COMMIT_SHA';
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function normalizeSourceCommitSha(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !GIT_SHA_PATTERN.test(value)) {
    throw new Error(
      'with-build-source-commit requires a lowercase 40-character sourceCommitSha or null.',
    );
  }
  return value;
}

function setIosBuildSourceMarker(infoPlist, sourceCommitSha) {
  if (sourceCommitSha === null) delete infoPlist[IOS_MARKER_KEY];
  else infoPlist[IOS_MARKER_KEY] = sourceCommitSha;
  return infoPlist;
}

function setAndroidBuildSourceMarker(application, sourceCommitSha) {
  application['meta-data'] = (application['meta-data'] ?? []).filter(
    (entry) => entry.$?.['android:name'] !== ANDROID_MARKER_NAME,
  );
  if (sourceCommitSha !== null) {
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      ANDROID_MARKER_NAME,
      sourceCommitSha,
    );
  }
  return application;
}

function withBuildSourceCommit(config, options = {}) {
  const sourceCommitSha = normalizeSourceCommitSha(options.sourceCommitSha);

  config = withInfoPlist(config, (modConfig) => {
    setIosBuildSourceMarker(modConfig.modResults, sourceCommitSha);
    return modConfig;
  });

  return withAndroidManifest(config, (modConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      modConfig.modResults,
    );
    setAndroidBuildSourceMarker(application, sourceCommitSha);
    return modConfig;
  });
}

module.exports = withBuildSourceCommit;
module.exports.IOS_MARKER_KEY = IOS_MARKER_KEY;
module.exports.ANDROID_MARKER_NAME = ANDROID_MARKER_NAME;
module.exports.normalizeSourceCommitSha = normalizeSourceCommitSha;
module.exports.setIosBuildSourceMarker = setIosBuildSourceMarker;
module.exports.setAndroidBuildSourceMarker = setAndroidBuildSourceMarker;
