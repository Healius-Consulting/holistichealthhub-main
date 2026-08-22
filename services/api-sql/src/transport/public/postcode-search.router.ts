import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { directoryAddressSummary } from '../../repositories/ports/directory.port.js';
import { SqlDirectoryRepository } from '../../repositories/sql/directory.sql.js';
import { SqlPostcodeSearchRepository } from '../../repositories/sql/postcode-search.sql.js';
import {
  directoryMapScaleMiles,
  geocodePostcode,
  projectDirectoryMapPositions,
  topFiveNearest,
} from '../../domain/geography/postcode.js';
import { publicPostcodeSearchLimiter } from '../../security/public-limits.js';

function lowerDeliveryCapability(value: string) {
  return value.toLowerCase() as 'none' | 'nationwide' | 'postcode_areas' | 'radius_miles';
}

function lowerIntakeState(value: string) {
  return value === 'LIMITED' ? 'limited' as const : 'available' as const;
}

export function createPublicPostcodeSearchRouter(): Router {
  const router = Router();
  const directoryRepo = new SqlDirectoryRepository();
  const searchRepo = new SqlPostcodeSearchRepository();

  router.post('/public/postcode-searches', publicPostcodeSearchLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { postcode } = z.object({ postcode: z.string().trim().min(2).max(16) }).parse(req.body);
      const geocode = await geocodePostcode(postcode);
      const profiles = geocode.status === 'matched' ? await directoryRepo.listEligibleProfiles() : [];
      const matches = geocode.status === 'matched'
        ? topFiveNearest(
          geocode,
          profiles.map(profile => ({
            ...profile,
            latitude: profile.latitude as number,
            longitude: profile.longitude as number,
          })),
        )
        : [];
      const status = geocode.status !== 'matched' ? geocode.status : matches.length ? 'matched' : 'no_match';
      const searchId = randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      await searchRepo.createSession({
        id: searchId,
        postcode: geocode.postcode,
        status,
        latitude: geocode.status === 'matched' ? geocode.latitude : null,
        longitude: geocode.status === 'matched' ? geocode.longitude : null,
        resultOrganisationIds: matches.map(match => match.profile.organisationId),
        expiresAt,
      });
      const mapProfiles = matches.map(match => match.profile);
      const mapPositions = geocode.status === 'matched'
        ? projectDirectoryMapPositions(geocode, mapProfiles)
        : [];
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        searchId,
        expiresAt,
        status,
        postcode: geocode.postcode,
        mapOrigin: { xPercent: 50, yPercent: 50 },
        mapRadiusMiles: geocode.status === 'matched' ? directoryMapScaleMiles(geocode, mapProfiles) : null,
        results: matches.map(({ profile, miles }, index) => ({
          id: profile.organisationId,
          tradingName: profile.tradingName,
          gphcNumber: profile.gphcNumber,
          addressSummary: directoryAddressSummary(profile),
          publicPhone: profile.publicPhone,
          website: profile.website ?? null,
          approximateMiles: Math.round(miles * 10) / 10,
          deliveryCapability: lowerDeliveryCapability(profile.deliveryCapability),
          collectionAvailable: profile.collectionAvailable,
          deliverySummary: profile.deliverySummary,
          intakeAvailability: lowerIntakeState(profile.intakeState),
          mapPosition: mapPositions[index],
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
