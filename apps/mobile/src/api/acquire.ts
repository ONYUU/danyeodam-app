import type { ApiClient } from './client';
import {
  expectIsoDate,
  expectIsoDateTime,
  expectLocalizedText,
  expectRecord,
  expectString,
  expectUuid,
  invalidPayload,
  resolveApiAssetUrl,
  type LocalizedText,
} from './payload';

import type { SupportedLocale } from '@/i18n/locales';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

export type AcquisitionCoordinates = {
  latitude: number;
  longitude: number;
  accuracy: number;
};

export type AcquireSuccess = {
  acquisition: {
    id: string;
    spotId: string;
    cardId: string;
    acquiredAt: string;
  };
  card: {
    id: string;
    title: LocalizedText;
    imageUrl: string;
    colorHex: string;
  };
  dateKst: string;
};

export class AcquireRequestError extends Error {
  constructor() {
    super('Acquisition request input is invalid.');
    this.name = 'AcquireRequestError';
  }
}

function isFiniteInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validateRequest(input: {
  spotId: string;
  idempotencyKey: string;
  coordinates: AcquisitionCoordinates;
}) {
  if (
    !UUID_PATTERN.test(input.spotId)
    || !UUID_V4_PATTERN.test(input.idempotencyKey)
    || !isFiniteInRange(input.coordinates.latitude, -90, 90)
    || !isFiniteInRange(input.coordinates.longitude, -180, 180)
    || !isFiniteInRange(input.coordinates.accuracy, 0, 50_000)
  ) {
    throw new AcquireRequestError();
  }
}

export function parseAcquireSuccess(
  value: unknown,
  input: { expectedSpotId: string; apiBaseUrl: string },
): AcquireSuccess {
  const record = expectRecord(value);
  const acquisition = expectRecord(record.acquisition);
  const card = expectRecord(record.card);
  const back = expectRecord(record.back);
  const acquisitionId = expectUuid(acquisition.id);
  const spotId = expectUuid(acquisition.spot_id);
  const cardId = expectUuid(acquisition.card_id);
  const projectedCardId = expectUuid(card.id);
  const imagePath = expectString(card.image_url, {
    minimumLength: 1,
    maximumLength: 128,
  });
  if (
    acquisition.type !== 'field'
    || spotId !== input.expectedSpotId
    || cardId !== projectedCardId
    || imagePath !== `/api/card-assets/${projectedCardId}`
  ) {
    return invalidPayload();
  }

  return {
    acquisition: {
      id: acquisitionId,
      spotId,
      cardId,
      acquiredAt: expectIsoDateTime(acquisition.acquired_at),
    },
    card: {
      id: projectedCardId,
      title: expectLocalizedText(card.title),
      imageUrl: resolveApiAssetUrl(input.apiBaseUrl, imagePath),
      colorHex: expectString(card.color_hex, {
        minimumLength: 7,
        maximumLength: 7,
        pattern: COLOR_PATTERN,
      }),
    },
    dateKst: expectIsoDate(back.date_kst),
  };
}

export function createAcquireService(dependencies: {
  client: ApiClient;
  apiBaseUrl: string;
}) {
  return async function acquire(input: {
    spotId: string;
    idempotencyKey: string;
    coordinates: AcquisitionCoordinates;
    locale: SupportedLocale;
    signal?: AbortSignal;
  }): Promise<AcquireSuccess> {
    validateRequest(input);
    const response = await dependencies.client<unknown>('/api/acquire', {
      method: 'POST',
      locale: input.locale,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      json: {
        spot_id: input.spotId,
        lat: input.coordinates.latitude,
        lng: input.coordinates.longitude,
        accuracy: input.coordinates.accuracy,
        idempotency_key: input.idempotencyKey,
      },
    });
    return parseAcquireSuccess(response, {
      expectedSpotId: input.spotId,
      apiBaseUrl: dependencies.apiBaseUrl,
    });
  };
}
