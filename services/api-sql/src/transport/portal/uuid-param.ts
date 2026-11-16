import { z } from 'zod';
import { asUuid } from '../../domain/common/uuid.js';

/**
 * A record id from a URL. Data Connect hands ids out without hyphens, and the portal
 * links with them as given, so accept either form and pass the canonical one on.
 */
export const uuidParam = z.string().trim().transform(asUuid).pipe(z.string().uuid());
