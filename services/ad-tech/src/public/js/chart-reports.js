document.addEventListener('DOMContentLoaded', () => {
  console.log('chart-reports.js loaded (expecting server-decoded data)');

  // --- Configuration & Constants ---
  const BUYER_MAP = {
    'https://privacy-sandbox-demos-dsp-a.dev': 1, // Buyer A ID = 1
    'https://privacy-sandbox-demos-dsp-b.dev': 2, // Buyer B ID = 2
    'https://privacy-sandbox-demos-dsp.dev': 3, // Generic DSP ID = 3
  };
  const BUYER_REV_MAP = {
    0: 'Unknown/Other',
    1: 'DSP A (dsp-a.dev)',
    2: 'DSP B (dsp-b.dev)',
    3: 'DSP (dsp.dev)',
  };
  const CPM_BIN_SIZE = 0.5;
  const MAX_CPM_FOR_BINNING = 10.0;
  const NUM_CPM_BINS = MAX_CPM_FOR_BINNING / CPM_BIN_SIZE; // 20 bins
  const BUYER_SHIFT = 5n; // Bit shift used in key generation

  // DOM Elements & State
  const chartCanvas = document.getElementById('bidDensityChart');
  const filterSelect = document.getElementById('dspFilter');
  const rawDataPre = document.getElementById('reportData');
  const clearLink = document.getElementById('clearReportsLink');
  let bidChart = null;
  let allAggregatedData = {}; // Structure: { buyerId: number[], ... }

  // --- Bucket Key Parsing ---
  /**
   * Parses the combined bucket key (received as a string from server)
   * back into buyer ID and CPM index.
   * @param {string} keyString - The combined bucket key as a string.
   * @returns {{cpmIndex: number, buyerId: number} | null} - Parsed indices or null if invalid.
   */
  function parseBidDensityBucketKey(keyString) {
    try {
      // Convert the string key back to BigInt for parsing
      const key = BigInt(keyString);

      // Mask to extract the lower bits used for CPM index
      const cpmIndexMask = (1n << BUYER_SHIFT) - 1n;
      // Extract CPM index by applying the mask
      const cpmIndex = Number(key & cpmIndexMask);
      // Extract buyer ID by shifting the key right
      const buyerId = Number(key >> BUYER_SHIFT);

      // Basic validation: Check if CPM index is within the expected range
      if (cpmIndex < 0 || cpmIndex >= NUM_CPM_BINS) {
        // console.warn("Parsed CPM index out of bounds:", cpmIndex, "from key string:", keyString);
        return null;
      }
      return {cpmIndex, buyerId};
    } catch (e) {
      console.error('Error parsing bucket key string:', keyString, e);
      return null;
    }
  }

  // --- Data Aggregation ---
  /**
   * Processes raw reports containing pre-decoded contributions.
   * @param {Array<object>} rawReports - Array of report objects from the server/EJS.
   */
  function aggregateData(rawReports) {
    allAggregatedData = {}; // Reset { buyerId: number[], ... }
    console.log(
      `Processing ${rawReports.length} raw reports (expecting pre-decoded)...`,
    );
    console.log(rawReports);
    let processedContributions = 0;
    let reportsWithContributions = 0;

    for (const report of rawReports) {
      // Access the pre-decoded contributions array added by the server
      const decodedContributions = report?.data?.decodedContributions;

      if (decodedContributions && Array.isArray(decodedContributions)) {
        reportsWithContributions++;
        for (const {bucket: bucketString, value} of decodedContributions) {
          // Parse the bucket string key
          const parsedKey = parseBidDensityBucketKey(bucketString);
          if (parsedKey) {
            const {buyerId, cpmIndex} = parsedKey;

            // Filter out unknown/unmapped DSPs (buyerId 0 or not in BUYER_REV_MAP)
            if (buyerId !== 0 && BUYER_REV_MAP.hasOwnProperty(buyerId)) {
              // Initialize the array for this buyer if it's the first time
              if (!allAggregatedData[buyerId]) {
                allAggregatedData[buyerId] = Array(NUM_CPM_BINS).fill(0);
              }
              // Ensure index is valid before adding
              if (cpmIndex >= 0 && cpmIndex < NUM_CPM_BINS) {
                allAggregatedData[buyerId][cpmIndex] += value;
                processedContributions++;
              } else {
                console.warn(
                  `Invalid cpmIndex ${cpmIndex} detected after parsing bucket string ${bucketString}`,
                );
              }
            } else {
              console.log(
                `Ignoring contribution from unknown/other buyer ID ${buyerId} for bucket string ${bucketString}`,
              );
            }
          } else {
            console.warn('Could not parse bucket key string:', bucketString);
          }
        }
      } else {
        console.log('Report skipped - no decodedContributions array found.');
      }
    }
    console.log(
      `Aggregation complete. Found ${reportsWithContributions} reports with contributions. Processed ${processedContributions} valid contributions. Final data:`,
      JSON.parse(JSON.stringify(allAggregatedData)),
    );
  }

  // --- Chart Rendering ---
  /**
   * Generates labels for the CPM bins (e.g., "$0.00 - $0.50").
   * @returns {Array<string>} - Array of labels.
   */
  function getCpmBinLabels() {
    const labels = [];
    for (let i = 0; i < NUM_CPM_BINS; i++) {
      const start = (i * CPM_BIN_SIZE).toFixed(2);
      const end = ((i + 1) * CPM_BIN_SIZE).toFixed(2);
      labels.push(`$${start} - $${end}`);
    }
    return labels;
  }

  /**
   * Renders or updates the Chart.js chart based on aggregated data and filter selection.
   * @param {string | number} selectedBuyerId - The ID of the buyer to display, or 'all'.
   */
  function renderChart(selectedBuyerId = 'all') {
    if (!chartCanvas) {
      console.error('Chart canvas element not found');
      return;
    }
    console.log('Rendering chart for buyer:', selectedBuyerId);

    const labels = getCpmBinLabels();
    const chartDataCounts = Array(NUM_CPM_BINS).fill(0); // Initialize counts for all bins

    if (selectedBuyerId === 'all') {
      // Sum counts across all known buyers defined in BUYER_MAP
      Object.keys(BUYER_MAP).forEach((key) => {
        const buyerId = BUYER_MAP[key];
        if (allAggregatedData[buyerId]) {
          for (let i = 0; i < NUM_CPM_BINS; i++) {
            chartDataCounts[i] += allAggregatedData[buyerId][i] || 0;
          }
        }
      });
    } else {
      // Use data only for the selected buyer
      const buyerIdNum = parseInt(selectedBuyerId, 10);
      if (allAggregatedData[buyerIdNum]) {
        for (let i = 0; i < NUM_CPM_BINS; i++) {
          chartDataCounts[i] = allAggregatedData[buyerIdNum][i] || 0;
        }
      }
    }

    const chartTitle =
      selectedBuyerId === 'all'
        ? 'Overall Bid Density (All Known DSPs)'
        : `Bid Density for ${BUYER_REV_MAP[selectedBuyerId] || `ID ${selectedBuyerId}`}`;

    if (bidChart) {
      bidChart.destroy();
    }

    bidChart = new Chart(chartCanvas, {
      type: 'bar',
      height: '500',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Bid Count',
            data: chartDataCounts,
            backgroundColor: 'rgba(75, 192, 192, 0.6)',
            borderColor: 'rgba(75, 192, 192, 1)',
            borderWidth: 1,
          },
        ],
      },
      options: {
        scales: {
          y: {
            beginAtZero: true,
            title: {display: true, text: 'Number of Bids'},
          },
          x: {title: {display: true, text: 'CPM Bin (USD)'}},
        },
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {display: false},
          title: {display: true, text: chartTitle},
          tooltip: {enabled: true},
        },
      },
    });
  }

  // --- Event Listeners and Initialization ---
  /**
   * Populates the DSP filter dropdown and adds change listener.
   */
  function setupFilter() {
    if (!filterSelect) {
      console.warn('Filter select element (#dspFilter) not found');
      return;
    }
    filterSelect.innerHTML = ''; // Clear existing

    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'All Known DSPs';
    filterSelect.appendChild(allOption);

    Object.keys(BUYER_REV_MAP).forEach((idStr) => {
      const buyerId = parseInt(idStr, 10);
      if (buyerId !== 0) {
        // Only add known DSPs
        const option = document.createElement('option');
        option.value = buyerId;
        option.textContent = BUYER_REV_MAP[buyerId];
        filterSelect.appendChild(option);
      }
    });

    filterSelect.addEventListener('change', (event) => {
      renderChart(event.target.value);
    });
  }

  // --- Main Execution ---
  /**
   * Initializes the report processing and chart rendering.
   */
  function main() {
    if (!rawDataPre) {
      console.error('Raw data element (<pre id="reportData">) not found.');
      return;
    }
    if (!chartCanvas) {
      console.error(
        'Chart canvas element (<canvas id="bidDensityChart">) not found.',
      );
      return;
    }

    let rawReports = [];
    try {
      const jsonData = rawDataPre.textContent || '[]';
      if (!jsonData.trim() || jsonData === '[]') {
        console.warn('No embedded report data found or data is empty.');
      } else {
        rawReports = JSON.parse(jsonData);
        // Expect server to have added report.data.decodedContributions
      }
    } catch (e) {
      console.error('Failed to parse embedded report data:', e);
      rawDataPre.textContent = `Error parsing embedded JSON data: ${e.message}`;
      return;
    }

    // Process the data (expects pre-decoded contributions)
    aggregateData(rawReports);

    // Setup UI elements
    setupFilter();

    // Render the initial chart
    renderChart('all');
  }

  // Run the initialization logic
  main();
});
