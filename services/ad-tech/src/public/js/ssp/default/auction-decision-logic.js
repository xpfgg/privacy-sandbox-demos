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

/**
 * Calculates a bucket index incorporating buyer ID and bid value.
 * CPM Bins: $0.50 width from $0 up to $10 (Indices 0-19).
 * Buyer IDs: Maps known buyers to IDs (1-3), unknown is 0.
 * Combined Key: Uses bit shifting (Buyer ID << 5 | CPM Index).
 *
 * @param {number} bidValue - The bid value (e.g., CPM).
 * @param {object} browserSignals - The browserSignals object from scoreAd.
 * @returns {bigint} The combined bucket key as a BigInt. Returns 0n if signals are missing.
 */
function getBidBucket(bidValue, browserSignals) {
  // --- Buyer ID Mapping ---
  const BUYER_MAP = {
    'https://privacy-sandbox-demos-dsp-a.dev': 1, // Buyer A ID = 1
    'https://privacy-sandbox-demos-dsp-b.dev': 2, // Buyer B ID = 2
    'https://privacy-sandbox-demos-dsp.dev': 3, // Generic DSP ID = 3
  };
  const UNKNOWN_BUYER_ID = 0; // ID for buyers not in the map

  let buyerId = UNKNOWN_BUYER_ID;
  try {
    const owner = browserSignals?.interestGroupOwner;
    if (owner && BUYER_MAP.hasOwnProperty(owner)) {
      buyerId = BUYER_MAP[owner];
    }
  } catch (e) {
    console.error('Error getting buyer ID:', e);
  }

  // --- CPM Bin Calculation ($0.50 bins, $0-$10 range) ---
  const CPM_BIN_SIZE = 0.5;
  const MAX_CPM_FOR_BINNING = 10.0;
  // Number of bins = 10.0 / 0.5 = 20 bins. Indices will be 0 to 19.
  const MAX_CPM_INDEX = MAX_CPM_FOR_BINNING / CPM_BIN_SIZE - 1; // Max index is 19

  let cpmIndex = 0;
  if (bidValue < 0) {
    cpmIndex = 0; // Bucket 0 for negative bids ($0.00 - $0.49 bin)
  } else if (bidValue >= MAX_CPM_FOR_BINNING) {
    cpmIndex = MAX_CPM_INDEX; // Bucket 19 for bids $10 and over ($9.50 - $10.00+ bin)
  } else {
    // Calculate index: e.g., $0.00 -> 0, $0.49 -> 0, $0.50 -> 1, $9.99 -> 19
    cpmIndex = Math.floor(bidValue / CPM_BIN_SIZE);
  }
  // Ensure index is within bounds just in case
  cpmIndex = Math.min(Math.max(0, cpmIndex), MAX_CPM_INDEX);

  // --- Combine into Bucket Key ---
  // Need 5 bits for CPM index (0-19 fits in 0-31 range).
  // Keep 4 bits for buyer ID (0-3 fits).
  // Shift buyer ID left by 5 bits, then OR with CPM index.
  // Example: Buyer 1, CPM $2.75 (index 5) -> (1 << 5) | 5 = 32 | 5 = 37 (0x25)
  // Example: Buyer 2, CPM $0.25 (index 0) -> (2 << 5) | 0 = 64 | 0 = 64 (0x40)
  try {
    const buyerShift = 5n; // Reserve 5 bits (0-31) for CPM index
    const finalBucket = (BigInt(buyerId) << buyerShift) | BigInt(cpmIndex);
    return finalBucket;
  } catch (e) {
    console.error('Error creating final bucket key:', e);
    return 0n; // Return 0n on error
  }
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
      // 1. Enable Debug Mode (optional, but sends an additional cleartext report)
      if (privateAggregation.enableDebugMode) {
        privateAggregation.enableDebugMode({debugKey: 12345n}); // Use a BigInt for the debug key
        console.debug(LOG_PREFIX, 'PA Debug Mode Enabled with key 12345');
      } else {
        console.debug(LOG_PREFIX, 'PA Debug Mode API not available.');
      }
      // 2. Contribute to Histogram (sends standard and potentially debug report)
      const calculatedBucket = getBidBucket(bid, browserSignals);
      privateAggregation.contributeToHistogram({
        bucket: calculatedBucket,
        value: 1,
      });
      console.debug(
        LOG_PREFIX,
        'Contributed simple count to Private Aggregation',
      );
    } else {
      console.debug(LOG_PREFIX, 'Private Aggregation API not available.');
    }
  } catch (error) {
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
