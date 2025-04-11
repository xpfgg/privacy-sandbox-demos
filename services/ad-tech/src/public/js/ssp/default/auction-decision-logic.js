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

/**
 * Where is this script used:
 *   This is the 'default' auction decision logic for an SSP.
 *
 * What does this script do:
 *   This script is referenced in auction configurations to choose among bids
 *   in a Protected Audience auction.
 */

const CURR_HOST = '<%= HOSTNAME %>';
const CURR_ORIGIN = '<%= CURRENT_ORIGIN %>';
const LOG_PREFIX = '[PSDemo] <%= HOSTNAME %> decision logic';

const USE_CASE_ID_BITS = 8;
const MAX_TOTAL_BITS = 128; // Maximum key size allowed by APIs

// Use Case IDs Registry (Add more as needed)
const USE_CASES = {
  // Private Aggregation Examples
  BID_DENSITY: 1,
  BID_REJECTION: 2,
  BID_DENSITY_ADVANCED: 3,
  UNIQUE_REACH: 25,
  // Attribution Reporting Examples (could also be used by PA)
  CONVERSION_COUNT: 10,
  CONVERSION_VALUE: 11,
};

/**
 * Configuration object defining the structure for each use case.
 * Keys are Use Case IDs from USE_CASES.
 */
const AGGREGATION_KEY_CONFIG = {
  [USE_CASES.BID_DENSITY]: {
    description: 'Basic Bid Density: CPM Bin, Buyer, Publisher',
    dimensions: [
      // Dimensions ordered by offset (right-to-left in the key)
      {
        name: 'cpmValue', // Input dimension name from dataDict
        outputName: 'cpmBinId', // Optional: for clarity if processed
        bits: 5,
        offset: 8, // Starts right after the 8 use case bits
        processor: {type: 'bin', params: {binSize: 0.5, maxThreshold: 10.0}},
      },
      {
        name: 'buyerId',
        outputName: 'buyerMappedId',
        bits: 3,
        offset: 13, // Starts after cpmBinId (8 + 5)
        processor: {
          type: 'map',
          params: {
            mapping: {
              'https://privacy-sandbox-demos-dsp-a.dev': 1,
              'https://privacy-sandbox-demos-dsp-b.dev': 2,
              'https://privacy-sandbox-demos-dsp.dev': 3,
            },
            defaultValue: 0,
          },
        },
      },
      {
        name: 'publisherId', // Assuming this is already an integer index
        outputName: 'publisherId',
        bits: 4,
        offset: 16, // Starts after buyerId (13 + 3)
        processor: {type: 'direct'}, // Explicitly state direct processing
      },
    ],
  },

  [USE_CASES.BID_REJECTION]: {
    description: 'Bid Rejection: CPM Bin, Seller, Reason',
    dimensions: [
      {
        name: 'cpmValue',
        outputName: 'cpmBinId',
        bits: 5,
        offset: 8,
        processor: {type: 'bin', params: {binSize: 0.5, maxThreshold: 10.0}},
      },
      {
        name: 'sellerId',
        outputName: 'sellerId',
        bits: 3,
        offset: 13,
        processor: {type: 'direct'},
      },
      {
        name: 'rejectionReasonId',
        outputName: 'rejectionReasonId',
        bits: 4,
        offset: 16,
        processor: {type: 'direct'},
      },
    ],
  },

  [USE_CASES.BID_DENSITY_ADVANCED]: {
    description: 'Advanced Bid Density (Multi-dimensional)',
    dimensions: [
      // Right-most dimension first (lowest offset)
      {
        name: 'geoId',
        outputName: 'geoId',
        bits: 6,
        offset: 8,
        processor: {type: 'direct'},
      },
      {
        name: 'deviceId',
        outputName: 'deviceId',
        bits: 3,
        offset: 14,
        processor: {type: 'direct'},
      },
      {
        name: 'slotId',
        outputName: 'slotId',
        bits: 5,
        offset: 17,
        processor: {type: 'direct'},
      },
      {
        name: 'categoryId',
        outputName: 'categoryId',
        bits: 8,
        offset: 22,
        processor: {type: 'direct'},
      },
      {
        name: 'buyerId',
        outputName: 'buyerId',
        bits: 10,
        offset: 30,
        processor: {type: 'direct'},
      }, // Assumes integer ID here
      {
        name: 'publisherId',
        outputName: 'publisherId',
        bits: 12,
        offset: 40,
        processor: {type: 'direct'},
      },
    ],
  },

  [USE_CASES.CONVERSION_COUNT]: {
    description: 'Conversion Count (Campaign, Geo, Product Cat)',
    dimensions: [
      {
        name: 'geoId',
        outputName: 'geoId',
        bits: 8,
        offset: 8,
        processor: {type: 'direct'},
      },
      {
        name: 'productCategoryId',
        outputName: 'productCategoryId',
        bits: 8,
        offset: 16,
        processor: {type: 'direct'},
      },
      {
        name: 'campaignId',
        outputName: 'campaignId',
        bits: 16,
        offset: 24,
        processor: {type: 'direct'},
      },
    ],
  },
  // --- Add configurations for other USE_CASE IDs ---
};

// --- Helper Function: Process Value ---

/**
 * Processes a raw dimension value into an integer index based on processor configuration.
 * @private - Internal helper function.
 * @param {*} rawValue - The input value for the dimension.
 * @param {object | undefined} processorConfig - Configuration object { type: 'direct'|'map'|'bin', params: {...} }.
 * @param {string} dimensionName - Name of the dimension for logging.
 * @returns {number} The processed integer index.
 * @throws {Error} If processing fails or config is invalid.
 */
function _processValue(rawValue, processorConfig, dimensionName) {
  const type =
    !processorConfig || !processorConfig.type ? 'direct' : processorConfig.type;
  const params =
    processorConfig && processorConfig.params ? processorConfig.params : {};

  try {
    switch (type) {
      case 'direct':
        if (typeof rawValue === 'number' && Number.isInteger(rawValue)) {
          return rawValue;
        }
        throw new Error(
          `Expected an integer, received type ${typeof rawValue} (${rawValue}).`,
        );

      case 'map': {
        const {mapping, defaultValue} = params;
        if (typeof mapping !== 'object' || mapping === null)
          throw new Error(
            "Processor 'map' requires a valid 'mapping' object in params.",
          );
        const key = String(rawValue); // Use string representation for lookup

        if (mapping.hasOwnProperty(key)) {
          const mappedValue = mapping[key];
          if (
            typeof mappedValue === 'number' &&
            Number.isInteger(mappedValue)
          ) {
            return mappedValue;
          } else {
            throw new Error(
              `Mapped value for key '${key}' is not an integer: ${mappedValue}.`,
            );
          }
        } else if (
          typeof defaultValue === 'number' &&
          Number.isInteger(defaultValue)
        ) {
          return defaultValue;
        } else {
          throw new Error(
            `Value '${key}' not found in map and no valid integer 'defaultValue' provided.`,
          );
        }
      }

      case 'bin': {
        const {
          binSize,
          maxThreshold,
          handleNegative = 'clampToZero',
          handleAboveMax = 'clampToMaxBin',
        } = params;
        if (typeof rawValue !== 'number' || isNaN(rawValue)) {
          throw new Error(
            `Expected a number, received type ${typeof rawValue} (${rawValue}).`,
          );
        }
        if (typeof binSize !== 'number' || binSize <= 0)
          throw new Error(`Invalid 'binSize': ${binSize}. Must be positive.`);
        if (typeof maxThreshold !== 'number')
          throw new Error(
            `Invalid 'maxThreshold': ${maxThreshold}. Must be number.`,
          );

        // Calculate the index of the bin containing values >= maxThreshold
        // Bins are [0, binSize), [binSize, 2*binSize), ..., [N*binSize, (N+1)*binSize == maxThreshold)
        // If value >= maxThreshold, clamp to the last valid index.
        // If maxThreshold=10, binSize=0.5, bins are 0..19. Index 19 is [9.5, 10.0). Clamp >=10 to 19.
        const maxValidIndex = Math.max(
          0,
          Math.floor(maxThreshold / binSize) -
            (maxThreshold === 0 || maxThreshold % binSize !== 0 ? 0 : 1),
        );

        if (rawValue < 0) {
          if (handleNegative === 'clampToZero') return 0;
          throw new Error(`Negative value ${rawValue} not allowed.`);
        }
        if (rawValue >= maxThreshold) {
          if (handleAboveMax === 'clampToMaxBin') return maxValidIndex;
          throw new Error(
            `Value ${rawValue} meets or exceeds maxThreshold ${maxThreshold}.`,
          );
        }
        // Standard binning calculation
        const binIndex = Math.floor(rawValue / binSize);
        // Ensure index doesn't somehow exceed max valid due to floating point issues near threshold
        return Math.min(binIndex, maxValidIndex);
      }

      default:
        throw new Error(`Unsupported processor type specified: '${type}'.`);
    }
  } catch (e) {
    // Add dimension context to the error
    throw new Error(
      `Error processing dimension '${dimensionName}': ${e.message}`,
    );
  }
}

// --- Main Function: Get Aggregation Key ---

/**
 * Generates a BigInt aggregation key based on the provided data dictionary
 * and the predefined configuration.
 *
 * @param {object} dataDict An object containing the useCaseId and all necessary
 * raw dimension values for that use case.
 * Example: { useCaseId: 1, cpmValue: 1.5, buyerId: 'dsp-a', publisherId: 5 }
 * @returns {bigint | null} The generated BigInt key, or null if an error occurs.
 * Errors are logged to the console.
 */
function getAggregationKey(dataDict) {
  if (!dataDict || typeof dataDict !== 'object') {
    console.error('[getAggregationKey] Error: Input must be an object.');
    return null;
  }

  const {useCaseId} = dataDict;

  // 1. Validate useCaseId and retrieve its configuration
  if (typeof useCaseId !== 'number' || !Number.isInteger(useCaseId)) {
    console.error(
      `[getAggregationKey] Error: 'useCaseId' is missing or not an integer in input data.`,
    );
    return null;
  }

  const useCaseConfig = AGGREGATION_KEY_CONFIG[useCaseId];
  if (!useCaseConfig) {
    console.error(`[getAggregationKey] Error: Unknown useCaseId: ${useCaseId}`);
    return null;
  }
  if (useCaseId < 0 || useCaseId >= 1 << USE_CASE_ID_BITS) {
    console.error(
      `[getAggregationKey] Error: useCaseId ${useCaseId} is out of range for ${USE_CASE_ID_BITS} bits.`,
    );
    return null;
  }

  // Start with the Use Case ID in the lowest bits
  let finalKey = BigInt(useCaseId);

  // 2. Iterate through dimensions defined for this use case
  if (!useCaseConfig.dimensions || !Array.isArray(useCaseConfig.dimensions)) {
    console.error(
      `[getAggregationKey] Error: Invalid dimensions configuration for useCaseId: ${useCaseId}.`,
    );
    return null;
  }

  for (const dimConfig of useCaseConfig.dimensions) {
    const {name, bits, offset, processor} = dimConfig;

    // Validate essential dimension config elements
    if (
      typeof name !== 'string' ||
      typeof bits !== 'number' ||
      bits <= 0 ||
      typeof offset !== 'number' ||
      offset < USE_CASE_ID_BITS
    ) {
      console.error(
        `[getAggregationKey] Error: Invalid config for dimension '${name}' in useCaseId ${useCaseId}.`,
      );
      return null;
    }

    // 3. Get the raw value from the input dictionary
    if (!dataDict.hasOwnProperty(name)) {
      console.error(
        `[getAggregationKey] Error: Missing required dimension value for '${name}' in input data for useCaseId: ${useCaseId}.`,
      );
      return null;
    }
    const rawValue = dataDict[name];

    // 4. Process the raw value into an integer index
    let processedValue;
    try {
      processedValue = _processValue(rawValue, processor, name);
    } catch (e) {
      console.error(
        `[getAggregationKey] Error for useCaseId ${useCaseId}: ${e.message}`,
      );
      return null;
    }

    // 5. Validate processed value fits allocated bits and clamp if necessary
    const maxValue = (1 << bits) - 1;
    let finalDimValue = processedValue;

    if (finalDimValue < 0) {
      console.warn(
        `[getAggregationKey] Warning (useCaseId ${useCaseId}, dim ${name}): Clamping negative value ${finalDimValue} to 0.`,
      );
      finalDimValue = 0;
    } else if (finalDimValue > maxValue) {
      console.warn(
        `[getAggregationKey] Warning (useCaseId ${useCaseId}, dim ${name}): Clamping value ${finalDimValue} to max ${maxValue} for ${bits} bits.`,
      );
      finalDimValue = maxValue;
    }

    // 6. Combine into the final key
    try {
      const valueBigInt = BigInt(finalDimValue);
      const shiftedValue = valueBigInt << BigInt(offset); // Offset is absolute from bit 0

      // Check for exceeding max key size
      const highestBitPosition = BigInt(offset + bits - 1);
      if (highestBitPosition >= MAX_TOTAL_BITS) {
        console.error(
          `[getAggregationKey] Error (useCaseId ${useCaseId}, dim ${name}): Dimension exceeds max key bits (${MAX_TOTAL_BITS}).`,
        );
        return null;
      }

      finalKey = finalKey | shiftedValue;
    } catch (e) {
      console.error(
        `[getAggregationKey] Error during bitwise operation for dimension '${name}' (useCaseId ${useCaseId}):`,
        e,
      );
      return null;
    }
  } // End loop through dimensions

  // 7. Return the successfully generated key
  return finalKey;
}

// ********************************************************
// Helper Functions
// ********************************************************
/** Checks whether the bid is below the winning contextual bid. */
function isBidBelowAuctionFloor({
  // UNUSED adMetadata,
  bid,
  auctionConfig,
  // UNUSED trustedScoringSignals,
  // UNUSED browserSignals,
}) {
  const {winningContextualBid} = auctionConfig.sellerSignals;
  if (!winningContextualBid) {
    return false;
  }
  return bid < Number(winningContextualBid.bid);
}

/** Checks real-time signals to see whether the ad creative is blocked. */
function isCreativeBlocked(scoringContext) {
  const {
    // UNUSED adMetadata,
    // UNUSED bid,
    auctionConfig,
    trustedScoringSignals,
    browserSignals,
  } = scoringContext;
  const {excludeCreativeTag} = auctionConfig.sellerSignals;
  if (!excludeCreativeTag) {
    return false; // No creative tags to exclude
  }
  const {renderURL} = browserSignals;
  if (trustedScoringSignals && trustedScoringSignals.renderURL[renderURL]) {
    const parsedScoringSignals = JSON.parse(
      trustedScoringSignals.renderURL[renderURL],
    );
    if (
      parsedScoringSignals &&
      parsedScoringSignals.tags &&
      parsedScoringSignals.tags.includes(excludeCreativeTag)
    ) {
      // Creative tag is to be excluded, reject bid.
      console.debug(LOG_PREFIX, 'rejecting bid blocked by publisher', {
        parsedScoringSignals,
        trustedScoringSignals,
        renderURL,
        buyer: browserSignals.interestGroupOwner,
        dataVersion: browserSignals.dataVersion,
        scoringContext,
      });
      return true;
    }
  }
  return false;
}

/** Checks whether the bid includes a valid and eligible deal ID. */
function doesBidHaveEligibleDeal({
  // UNUSED adMetadata,
  // UNUSED bid,
  auctionConfig,
  // UNUSED trustedScoringSignals,
  browserSignals,
}) {
  const {availableDeals} = auctionConfig.auctionSignals;
  if (!availableDeals || !availableDeals.length) {
    return false; // No deals available.
  }
  const {selectedBuyerAndSellerReportingId} = browserSignals;
  return availableDeals.includes(selectedBuyerAndSellerReportingId);
}

// ********************************************************
// Top-level decision logic functions
// ********************************************************
function scoreAd(
  adMetadata,
  bid,
  auctionConfig,
  trustedScoringSignals,
  browserSignals,
) {
  const scoringContext = {
    adMetadata,
    bid,
    auctionConfig,
    trustedScoringSignals,
    browserSignals,
  };
  console.debug(LOG_PREFIX, 'scoreAd() invoked', {scoringContext});

  // contributeToHistogram through Private Aggregation for Bid Density
  try {
    if (
      typeof privateAggregation !== 'undefined' &&
      privateAggregation.contributeToHistogram
    ) {
      // 1. Enable Debug Mode (optional)
      if (privateAggregation.enableDebugMode) {
        // Use a fixed or appropriately configured debug key
        const debugKey = 12345n;
        privateAggregation.enableDebugMode({debugKey: debugKey});
        console.debug(LOG_PREFIX, `PA Debug Mode Enabled with key ${debugKey}`);
      } else {
        console.debug(LOG_PREFIX, 'PA Debug Mode API not available.');
      }

      // 2. Prepare data dictionary for the aggregation key utility
      // --- IMPORTANT: Define how 'publisherIdentifier' is obtained ---
      // The USE_CASES.BID_DENSITY config expects 'publisherId' as a direct integer.
      // You need to get this value from the available signals (auctionConfig, browserSignals, etc.)
      // and potentially map it to a pre-defined integer ID.
      // Example Placeholder: Assume it's available in sellerSignals and is already an integer.
      // Replace with your actual logic.
      const publisherIdentifier = auctionConfig.sellerSignals?.publisherId ?? 0; // FALLBACK TO 0 if undefined - ADJUST AS NEEDED!

      const aggregationData = {
        useCaseId: USE_CASES.BID_DENSITY, // Use Case 1: Basic Bid Density
        cpmValue: bid, // Raw bid value for 'bin' processor
        buyerId: browserSignals.interestGroupOwner, // Raw buyer origin for 'map' processor
        publisherId: 0, // Integer ID for 'direct' processor
      };
      console.log('aggregationData', aggregationData);

      // 3. Generate the aggregation key using the utility function
      const calculatedBucket = getAggregationKey(aggregationData);

      // 4. Contribute to Histogram if key generation was successful
      if (calculatedBucket !== null) {
        privateAggregation.contributeToHistogram({
          bucket: calculatedBucket, // The BigInt key returned by the utility
          value: 1, // Count each bid scored
        });
        console.debug(
          LOG_PREFIX,
          `Contributed count to Private Aggregation for Bid Density. Bucket: 0x${calculatedBucket.toString(16)}`,
        );
      } else {
        // Log an error if key generation failed (utility logs details internally)
        console.error(
          LOG_PREFIX,
          'Failed to generate aggregation key for Bid Density contribution.',
          // Optionally log the data that failed for easier debugging:
          {failureInput: aggregationData},
        );
      }
    } else {
      console.debug(LOG_PREFIX, 'Private Aggregation API not available.');
    }
  } catch (error) {
    // Catch errors from API calls like enableDebugMode or contributeToHistogram
    console.error(LOG_PREFIX, 'Private Aggregation Error:', error);
  }

  // Initialize ad score defaulting to a first-price auction.
  const score = {
    desirability: bid,
    allowComponentAuction: true,
  };
  // Check if ad creative is blocked.
  if (isCreativeBlocked(scoringContext)) {
    score.desirability = 0;
    score.rejectReason = 'disapproved-by-exchange';
    console.warn(LOG_PREFIX, 'rejecting bid with blocked creative', {
      scoringContext,
    });
    return score;
  }
  // Check if DSP responded with an eligible deal ID.
  const bidHasEligibleDeal = doesBidHaveEligibleDeal(scoringContext);
  const {strictRejectForDeals} = auctionConfig.auctionSignals;
  if (strictRejectForDeals && !bidHasEligibleDeal) {
    // Only accepting bids with eligible bids.
    score.desirability = 0;
    score.rejectReason = 'invalid-bid';
    console.warn(LOG_PREFIX, 'rejecting bid with ineligible deal', {
      scoringContext,
    });
    return score;
  } else if (bidHasEligibleDeal) {
    // Boost desirability score by 10 points for bids with eligible deals.
    score.desirability = bid + 10.0;
    console.info(LOG_PREFIX, 'boosting bid with eligible deal', {
      scoringContext,
    });
    return score;
  }
  // Check if bid is below auction floor.
  if (isBidBelowAuctionFloor(scoringContext)) {
    score.desirability = 0;
    score.rejectReason = 'bid-below-auction-floor';
    console.warn(LOG_PREFIX, 'rejecting bid below auction floor', {
      scoringContext,
    });
    return score;
  }
  // In all other cases, default to a first-price auction.
  console.info(LOG_PREFIX, 'scored bid', {scoringContext, score});
  return score;
}

function reportResult(auctionConfig, browserSignals) {
  const reportingContext = {
    auctionId: auctionConfig.auctionSignals.auctionId,
    pageURL: auctionConfig.auctionSignals.pageURL,
    topLevelSeller: browserSignals.topLevelSeller,
    winningBuyer: browserSignals.interestGroupOwner,
    renderURL: browserSignals.renderURL,
    bid: browserSignals.bid,
    bidCurrency: browserSignals.bidCurrency,
    buyerAndSellerReportingId: browserSignals.buyerAndSellerReportingId,
    selectedBuyerAndSellerReportingId:
      browserSignals.selectedBuyerAndSellerReportingId,
  };
  let reportUrl = auctionConfig.seller + '/reporting?report=result';
  for (const [key, value] of Object.entries(reportingContext)) {
    reportUrl = `${reportUrl}&${key}=${value}`;
  }
  console.info(LOG_PREFIX, 'reportResult() invoked', {
    auctionConfig,
    browserSignals,
    reportingContext,
    sendReportToUrl: reportUrl,
  });
  sendReportTo(reportUrl);
  return /* sellerSignals= */ {
    success: true,
    auctionId: auctionConfig.auctionSignals.auctionId,
    buyer: browserSignals.interestGroupOwner,
    reportUrl: auctionConfig.seller + '/reporting',
    signalsForWinner: {signalForWinner: 1},
  };
}
