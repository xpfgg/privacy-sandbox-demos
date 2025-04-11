/*
 Copyright 2022 Google LLC
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
      https://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

import express, {Request, Response} from 'express';
import {
  Report,
  ReportCategory,
  ReportStore,
} from '../../controllers/report-store.js';
import {
  getAttributionSourceHeaders,
  getAttributionRedirectUrl,
} from '../../lib/attribution-reporting-helper.js';
import {
  getStructuredObject,
  getEjsTemplateVariables,
} from '../../lib/common-utils.js';
import {decodeDict} from 'structured-field-values';

/**
 * This router is responsible for handling event-level report requests
 * generated typically from Protected Audience auctions, such as via
 * sendReportTo() from reportResult() or reportWin(), ad beacons with the
 * Fenced Frames Ads Reporting API or trackingEvents included in the VAST XML.
 *
 * Path: /reporting/
 */
export const ReportRouter = express.Router();

// ************************************************************************
// Helper functions
// ************************************************************************
/** Sets ARA source registration headers if request is eligible. */
const setAttributionReportingHeaders = (req: Request, res: Response) => {
  if ('attribution-reporting-eligible' in req.headers) {
    const attributionEligibleHeader = decodeDict(
      req.headers['attribution-reporting-eligible'] as string,
    );
    const queryParams = getStructuredObject(req.query);
    const sourceHeaders = getAttributionSourceHeaders(
      queryParams,
      attributionEligibleHeader,
    );
    if (sourceHeaders) {
      console.log(
        '[ARA] Request is eligible for attribution reporting.',
        req.originalUrl,
        sourceHeaders,
      );
      res.setHeader(
        'Attribution-Reporting-Register-Source',
        JSON.stringify(sourceHeaders),
      );
    }
  } else {
    console.log(
      '[ARA] Request is not eligible for attribution reporting.',
      req.originalUrl,
    );
  }
};

// ************************************************************************
// HTTP handlers
// ************************************************************************
/** Receives event logs and registers attribution source if eligible. */
ReportRouter.get('/', async (req: Request, res: Response) => {
  const report: Report = {
    category: ReportCategory.EVENT_LEVEL_LOG,
    timestamp: Date.now().toString(),
    data: req.query,
  };
  console.log('Event-level report received: ', req.baseUrl, report);
  ReportStore.addReport(report);
  setAttributionReportingHeaders(req, res);
  const queryParams = getStructuredObject(req.query);
  const redirectUrl = getAttributionRedirectUrl(queryParams);
  if (redirectUrl) {
    console.log('[ARA] Following redirect chain: ', redirectUrl);
    res.redirect(redirectUrl);
    return;
  }
  res
    .status(200)
    .send(`Received event-level report: ${JSON.stringify(queryParams)}`);
});

/** Receives event logs and registers attribution source if eligible. */
ReportRouter.post('/', async (req: Request, res: Response) => {
  const report: Report = {
    category: ReportCategory.EVENT_LEVEL_LOG,
    timestamp: Date.now().toString(),
    data: {
      ...req.query,
      ...req.body,
    },
  };
  console.log('Event-level report received: ', req.baseUrl, report);
  ReportStore.addReport(report);
  setAttributionReportingHeaders(req, res);
  const queryParams = getStructuredObject(req.query);
  const redirectUrl = getAttributionRedirectUrl(queryParams);
  if (redirectUrl) {
    console.log('[ARA] Following redirect chain: ', redirectUrl);
    res.redirect(redirectUrl);
    return;
  }
  res
    .status(200)
    .send(`Received event-level report: ${JSON.stringify(queryParams)}`);
});

// ****************************************************************************
// This endpoint is not functionally used in use-case journeys, but rather to
// quickly demonstrate the event-level reports the ad-tech server received
// within the last 10 minutes.
// ****************************************************************************
/** Shows all reports from in-memory storage. */
ReportRouter.get('/view-reports', async (req: Request, res: Response) => {
  const hostDetails = getEjsTemplateVariables(/* title= */ 'Reports');
  res.render('view-reports', {
    reports: ReportStore.getAllReports(),
    ...hostDetails,
  });
});

ReportRouter.get('/clear-reports', async (req: Request, res: Response) => {
  ReportStore.clearReports();
  res.status(200).json({Message: 'Reports have been cleared'});
});

import cbor from 'cbor';

// Decodes Base64 CBOR Aggregation Service Payload
async function decodePayload(
  payload: string,
): Promise<{bucket: bigint; value: number}[]> {
  try {
    const arr = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const decoded: any = await cbor.decodeFirst(arr);

    if (!decoded?.data || !Array.isArray(decoded.data)) {
      // Simplified check
      throw new Error("Decoded data missing 'data' array");
    }

    const contributions = decoded.data
      .map((item: any): {bucket: bigint; value: number} | null => {
        if (!item?.bucket || typeof item.value === 'undefined') {
          // Check existence and type if needed
          // console.warn("Skipping invalid item:", item); // Optional log
          return null;
        }
        try {
          // Assumes Buffer-like objects with toString('hex') and readUInt32BE
          const bucketBigInt = BigInt(`0x${item.bucket.toString('hex')}`);
          const valueNumber = item.value.readUInt32BE(0);
          return {bucket: bucketBigInt, value: valueNumber};
        } catch (mapError: any) {
          console.error('Error processing CBOR item:', mapError.message, item); // Log specific error
          return null;
        }
      })
      .filter(
        (item: any): item is {bucket: bigint; value: number} => item !== null,
      ); // Filter nulls, type predicate still works with inline type

    return contributions;
  } catch (error: any) {
    console.error(`Error decoding payload: ${error.message}`);
    // Avoid logging full payload in error? console.error("Input payload:", payload);
    throw error; // Re-throw
  }
}

// --- View Decoded Reports ---

// Fetches reports, decodes payloads, and renders the chart view
ReportRouter.get('/chart-reports', async (req: Request, res: Response) => {
  try {
    const hostDetails = getEjsTemplateVariables(/* title= */ 'Reports');
    const rawReports = ReportStore.getAllReports();

    const reportsWithDecodedData = await Promise.all(
      rawReports.map(async (report: any) => {
        let decodedContributions: {bucket: string; value: number}[] = [];
        let payloadString: string | undefined = undefined;

        console.log(report);

        // Safely find payload string (adjust based on actual report structure)
        try {
          console.log(report.data.aggregation_service_payloads[0]);
          payloadString =
            report?.data?.aggregation_service_payloads?.[0]
              ?.debug_cleartext_payload;
          console.log(payloadString);
          // Add checks for other possible structures if needed
          // if (!payloadString && typeof report?.debugPayloadField === 'string') {
          //    payloadString = report.debugPayloadField;
          // }
        } catch (e) {
          /* Ignore access errors */
        }

        if (typeof payloadString === 'string') {
          try {
            const rawContributions = await decodePayload(payloadString);
            decodedContributions = rawContributions.map(({bucket, value}) => ({
              bucket: bucket.toString(),
              value: value,
            }));
          } catch (decodingError: any) {
            console.error(
              `Failed to decode payload for report: ${decodingError.message}`,
            );
          }
        }

        return {
          ...report,
          data: {...(report.data || {}), decodedContributions},
        };
      }),
    );

    res.render('chart-reports', {
      // Renders the same template used by frontend JS
      reports: reportsWithDecodedData,
      ...hostDetails,
    });
  } catch (routeError: any) {
    console.error('Error in /chart-reports route:', routeError);
    res.status(500).render('error', {
      message: 'Failed to load or process reports.',
      error: routeError,
      ...getEjsTemplateVariables('Error'),
    });
  }
});
