// Import necessary modules
const { Builder, By, Key, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const chromedriver = require('chromedriver');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const yargs = require('yargs');
const colors = require('colors');
const { Parser } = require('json2csv');

// Print functions
function printInfo(message) {
    console.log(colors.blue(message));
}

function printSuccess(message) {
    console.log(colors.green(message));
}

function printWarning(message) {
    console.log(colors.yellow(message));
}

function printError(message) {
    console.log(colors.red(message));
}

// Function to get the next batch number based on existing files
function getNextBatchNumber(downloadDir) {
    const files = fs.readdirSync(downloadDir);
    const batchNumbers = files
        .map(file => {
            const match = file.match(/^Export_HS2022_Batch (\d+)\.xlsx$/);
            return match ? parseInt(match[1], 10) : null;
        })
        .filter(num => num !== null);

    const maxNumber = batchNumbers.length > 0 ? Math.max(...batchNumbers) : 0;
    return maxNumber + 1;
}

// Function to read processed HS codes from CSV
function readProcessedHsCodes(processedHsCsv) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(processedHsCsv)) {
            printInfo(`File '${processedHsCsv}' tidak ditemukan. Menganggap tidak ada Kode HS yang telah diproses.`);
            return resolve([]);
        }

        printInfo(`Membaca Kode HS yang telah diproses dari file '${processedHsCsv}'`);
        let processedHsCodes = [];
        fs.createReadStream(processedHsCsv)
            .pipe(csv())
            .on('data', (row) => {
                if ('HS Code' in row) {
                    // Remove quotes if present
                    const hsCode = row['HS Code'].replace(/"/g, '').trim();
                    processedHsCodes.push(hsCode);
                }
            })
            .on('end', () => {
                printInfo(`Total Kode HS yang telah diproses: ${processedHsCodes.length}`);
                resolve(processedHsCodes);
            })
            .on('error', (error) => {
                printError(`Gagal membaca file '${processedHsCsv}': ${error}`);
                reject(error);
            });
    });
}

// Function to append processed HS codes to CSV
function appendProcessedHsCodes(processedHsCsv, hsCodes) {
    const fileExists = fs.existsSync(processedHsCsv);
    const json2csvParser = new Parser({ header: !fileExists, fields: ['HS Code'] });
    const csvData = json2csvParser.parse(hsCodes.map(code => ({ 'HS Code': code }))) + '\n';
    fs.appendFileSync(processedHsCsv, csvData, 'utf8');
    printInfo(`Menambahkan ${hsCodes.length} Kode HS ke file '${processedHsCsv}'`);
}

// Function to append failed batches to a log file
function logFailedBatch(failedBatchLog, batch, error) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - Batch: ${batch.join(', ')} - Error: ${error}\n`;
    fs.appendFileSync(failedBatchLog, logEntry, 'utf8');
    printError(`Batch gagal diproses dan dicatat di '${failedBatchLog}'`);
}

// Initialize WebDriver
async function initializeDriver(headless = false, downloadDir = "D:/Data HP14 Backup/3 INTERN/CESGS/9 - Scraping BPS Exim/Ekspor 2020-2021 Batch 1") {
    printInfo("Menginisialisasi WebDriver...");

    // Create download directory if it doesn't exist
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
        printInfo(`Direktori unduhan '${downloadDir}' telah dibuat.`);
    } else {
        printInfo(`Direktori unduhan '${downloadDir}' sudah ada.`);
    }

    // Set Chrome options
    let options = new chrome.Options();
    options.addArguments("--start-maximized");
    options.addArguments("--enable-logging");
    options.addArguments("--v=1");
    options.addArguments("--disable-blink-features=AutomationControlled");
    options.addArguments("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    if (headless) {
        options.addArguments("--headless");
        printInfo("Mode headless diaktifkan.");
    }
    options.addArguments("--disable-gpu");
    options.addArguments("--no-sandbox");
    options.addArguments("--disable-popup-blocking");
    options.addArguments("--disable-extensions");
    options.addArguments("--disable-notifications");

    // Set download preferences
    options.setUserPreferences({
        'download.default_directory': downloadDir.replace(/\//g, '\\'),
        'download.prompt_for_download': false,
        'download.directory_upgrade': true,
        'safebrowsing.enabled': true,
        'safebrowsing.disable_download_protection': true,
    });

    // Build the driver
    let driver = await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .build();

    printSuccess("WebDriver berhasil diinisialisasi.");
    return driver;
}

// Function to wait for download to complete
function waitForDownload(downloadDir) {
    return new Promise((resolve, reject) => {
        const downloadTimeout = 60000; // Maximum wait time for download (60 seconds)
        const pollInterval = 1000; // Check every 1 second
        let timeElapsed = 0;

        const checkDownload = setInterval(() => {
            fs.readdir(downloadDir, (err, files) => {
                if (err) {
                    clearInterval(checkDownload);
                    return reject(err);
                }

                const downloadingFiles = files.filter(file => file.endsWith('.crdownload'));
                const downloadedFiles = files.filter(file => !file.endsWith('.crdownload') && (file.endsWith('.xlsx') || file.endsWith('.xls')));

                if (downloadingFiles.length === 0 && downloadedFiles.length > 0) {
                    // Get the most recently modified file
                    let latestFile;
                    let latestMTime = 0;

                    downloadedFiles.forEach(file => {
                        let filePath = path.join(downloadDir, file);
                        let stats = fs.statSync(filePath);
                        if (stats.mtimeMs > latestMTime) {
                            latestMTime = stats.mtimeMs;
                            latestFile = file;
                        }
                    });

                    clearInterval(checkDownload);
                    resolve(latestFile);
                } else if (timeElapsed >= downloadTimeout) {
                    clearInterval(checkDownload);
                    reject(new Error('Download timeout'));
                }

                timeElapsed += pollInterval;
            });
        }, pollInterval);
    });
}

// Select radio button
async function selectRadioButton(driver, jenis) {
    let radioId = jenis.toLowerCase() === 'ekspor' ? 'jenis-radio-1' : 'jenis-radio-2';
    try {
        let radio = await driver.wait(until.elementLocated(By.id(radioId)), 15000);
        await driver.wait(until.elementIsEnabled(radio), 15000);
        await radio.click();
        printSuccess(`Memilih '${jenis}'.`);
    } catch (e) {
        printError(`Gagal memilih radio button '${jenis}': ${e}`);
        throw e;
    }
    await driver.sleep(2000);
}

// Input selection with Enter
async function inputSelectionWithEnter(driver, selector, text) {
    printInfo(`Mencari input field dengan CSS Selector '${selector}' untuk memasukkan '${text}'...`);
    try {
        let inputField = await driver.wait(until.elementLocated(By.css(selector)), 10000);
        await driver.wait(until.elementIsEnabled(inputField), 10000);
        await inputField.click();
        await inputField.sendKeys(Key.CONTROL, "a", Key.NULL); // Clear existing text
        await inputField.sendKeys(text, Key.ENTER);
        printSuccess(`Memasukkan '${text}' dan menekan Enter.`);
        await driver.sleep(2000);

        // Close dropdown by pressing ESCAPE
        await inputField.sendKeys(Key.ESCAPE);
        await driver.sleep(1000);

        // Click outside dropdown to ensure it's closed
        let body = await driver.findElement(By.tagName('body'));
        await body.click();
        await driver.sleep(1000);
    } catch (e) {
        printError(`Gagal memasukkan '${text}': ${e}`);
        throw e;
    }
}

// Get available selector
async function getAvailableSelector(driver, selectors) {
    for (let selector of selectors) {
        try {
            let elements = await driver.findElements(By.css(selector));
            if (elements.length > 0) {
                return selector;
            }
        } catch (e) {
            continue;
        }
    }
    return null;
}

// Select years
async function selectYears(driver, years) {
    let possibleSelectors = ["input#react-select-5-input", "input#react-select-6-input"];

    let inputCssSelector = await getAvailableSelector(driver, possibleSelectors);

    if (!inputCssSelector) {
        printError("Tidak dapat menemukan input field untuk memilih tahun.");
        throw new Error("Selector untuk input tahun tidak ditemukan.");
    }

    printInfo(`Menggunakan selector: ${inputCssSelector}`);

    // Input each year
    for (let year of years) {
        try {
            printInfo(`Memilih tahun: ${year}`);
            await inputSelectionWithEnter(driver, inputCssSelector, year);
        } catch (e) {
            printError(`Gagal memilih tahun '${year}': ${e}`);
            throw e;
        }
    }

    // Click outside dropdown to ensure it's closed
    try {
        let body = await driver.findElement(By.tagName('body'));
        await body.click();
        await driver.sleep(1000);
    } catch (e) {
        printError(`Gagal mengklik body untuk menutup dropdown: ${e}`);
    }
}

// Read HS codes from CSV
function readHsCodes(csvFile) {
    return new Promise((resolve, reject) => {
        printInfo(`Membaca Kode HS dari file CSV: '${csvFile}'`);
        let hsCodes = [];
        fs.createReadStream(csvFile)
            .pipe(csv())
            .on('data', (row) => {
                if ('HS Code' in row) {
                    // Remove quotes if present
                    const hsCode = row['HS Code'].replace(/"/g, '').trim();
                    hsCodes.push(hsCode);
                }
            })
            .on('end', () => {
                printInfo(`Total Kode HS yang dibaca: ${hsCodes.length}`);
                if (hsCodes.length > 0) {
                    printInfo(`HS Code pertama: ${hsCodes[0]}`);
                    if (hsCodes.length > 1) {
                        printInfo(`HS Code kedua: ${hsCodes[1]}`);
                    }
                    printInfo(`HS Code terakhir: ${hsCodes[hsCodes.length - 1]}`);
                }
                resolve(hsCodes);
            })
            .on('error', (error) => {
                printError(`Gagal membaca file CSV '${csvFile}': ${error}`);
                reject(error);
            });
    });
}

// Input HS codes batch
async function inputHsCodesBatch(driver, hsCodes) {
    let inputCssSelector = "input#react-select-11-input";
    printInfo(`Memulai input batch Kode HS: ${hsCodes}`);
    try {
        for (let hsCode of hsCodes) {
            printInfo(`Memasukkan Kode HS: ${hsCode}`);
            let inputField = await driver.wait(until.elementLocated(By.css(inputCssSelector)), 15000);
            await inputField.click();
            await inputField.sendKeys(hsCode);
            await driver.sleep(5000);
            await inputField.sendKeys(Key.ENTER);
            await driver.sleep(500);
        }

        // After entering the batch, close the dropdown and click outside
        await driver.actions().sendKeys(Key.ESCAPE).perform();
        await driver.sleep(1000);
        let body = await driver.findElement(By.tagName('body'));
        await body.click();
        await driver.sleep(1000);
        return true; // Success
    } catch (e) {
        printError(`Gagal memasukkan batch Kode HS: ${e}`);
        return false; // Failure
    }
}

// Function to scroll to the top of the page
async function scrollToTop(driver) {
    try {
        await driver.executeScript("window.scrollTo(0, 0);");
        printSuccess("Berhasil menggulir ke atas halaman.");
        await driver.sleep(1000); // Tunggu sebentar untuk memastikan scroll selesai
    } catch (e) {
        printError(`Gagal menggulir ke atas halaman: ${e}`);
        throw e;
    }
}

// Function to select download type from dropdown (modified to select the second dropdown)
async function selectDownloadType(driver, downloadType) {
    // Define the selectors
    const dropdownSelector = "div.pvtDropdown > div.pvtDropdownValue"; // Selector for the dropdown button
    const nilaiOptionXPath = "//div[@class='pvtDropdownMenu']//div[text()='Nilai / Net Value (US $)']";
    const beratOptionXPath = "//div[@class='pvtDropdownMenu']//div[text()='Berat / Net Weight (KG)']";

    try {
        printInfo(`Mencari dan mengklik dropdown untuk memilih jenis pengunduhan: '${downloadType}'`);
        // Cari semua dropdown yang cocok
        let dropdowns = await driver.findElements(By.css(dropdownSelector));
        if (dropdowns.length < 2) {
            throw new Error("Dropdown kedua tidak ditemukan.");
        }

        // Pilih dropdown yang kedua (indeks 1 jika hanya dua, atau elemen terakhir)
        let dropdown = dropdowns[dropdowns.length - 1]; // atau gunakan dropdowns[1] jika yakin hanya dua
        await driver.wait(until.elementIsEnabled(dropdown), 10000);
        await dropdown.click();
        printSuccess("Berhasil mengklik dropdown kedua.");

        await driver.sleep(1000); // Tunggu dropdown terbuka

        // Tentukan XPath berdasarkan pilihan
        let optionXPath;
        if (downloadType.toLowerCase() === 'nilai') {
            optionXPath = nilaiOptionXPath;
        } else if (downloadType.toLowerCase() === 'berat') {
            optionXPath = beratOptionXPath;
        } else {
            throw new Error("Jenis pengunduhan tidak valid. Pilih 'Nilai' atau 'Berat'.");
        }

        // Klik opsi yang dipilih
        let option = await driver.wait(until.elementLocated(By.xpath(optionXPath)), 10000);
        await driver.wait(until.elementIsEnabled(option), 10000);
        await option.click();
        printSuccess(`Berhasil memilih '${downloadType}'.`);

        await driver.sleep(1000); // Tunggu setelah memilih opsi

    } catch (e) {
        printError(`Gagal memilih jenis pengunduhan '${downloadType}': ${e}`);
        throw e;
    }
}

// Click "Buat Tabel" button
async function clickCreateTable(driver) {
    printInfo("Mencari dan mengklik tombol 'Buat Tabel'...");
    try {
        let buatTabelButton = await driver.wait(until.elementLocated(By.xpath("//button[span[text()='Buat Tabel']]")), 15000);
        await driver.wait(until.elementIsEnabled(buatTabelButton), 15000);
        await buatTabelButton.click();
        printSuccess("Berhasil mengklik tombol 'Buat Tabel'.");
        await driver.sleep(5000);
        return true; // Success
    } catch (e) {
        printError(`Gagal mengklik tombol 'Buat Tabel': ${e}`);
        return false; // Failure
    }
}

// Click "Unduh" button
async function clickUnduhButton(driver) {
    printInfo("Mencari dan mengklik tombol 'Unduh'...");
    try {
        let unduhButton = await driver.wait(until.elementLocated(By.css("button.download-product")), 15000);
        await driver.wait(until.elementIsEnabled(unduhButton), 15000);
        await unduhButton.click();
        printSuccess("Berhasil mengklik tombol 'Unduh'.");
        await driver.sleep(2000); // Tunggu sedikit sebelum memilih jenis pengunduhan
        return true; // Success
    } catch (e) {
        printError(`Gagal mengklik tombol 'Unduh': ${e}`);
        return false; // Failure
    }
}

// Click "Unduh" button and handle download type (updated to use the modified selectDownloadType)
async function handleDownload(driver, downloadType, downloadDir, batchNumber) {
    // Pilih Download Type dari dropdown kedua
    await selectDownloadType(driver, downloadType);

    // Klik tombol "Unduh" setelah memilih jenis pengunduhan
    let unduhSuccess = await clickUnduhButton(driver);
    if (!unduhSuccess) throw new Error("Gagal mengklik tombol 'Unduh'.");

    // Tunggu unduhan selesai
    printInfo("Menunggu unduhan selesai...");
    let downloadedFile = await waitForDownload(downloadDir);
    printSuccess(`File diunduh: ${downloadedFile}`);

    // Rename the file
    let newFileName = `Export_HS2020_Batch ${batchNumber}.xlsx`;
    let oldFilePath = path.join(downloadDir, downloadedFile);
    let newFilePath = path.join(downloadDir, newFileName);

    fs.renameSync(oldFilePath, newFilePath);
    printSuccess(`File diubah namanya menjadi '${newFileName}'.`);
}

// Reset form
async function resetForm(driver, jenis, agregasi, jenisHs, years) {
    try {
        printInfo("Mencoba untuk mereset formulir dengan me-refresh halaman...");
        await driver.navigate().refresh();
        printSuccess("Halaman berhasil di-refresh.");
        await driver.sleep(3000);

        // Scroll ke atas setelah refresh
        await scrollToTop(driver);

        // Setelah scroll, lanjutkan dengan memilih opsi yang diperlukan
        // 1. Select Data: Ekspor atau Impor
        await selectRadioButton(driver, jenis);

        // 2. Select Agregasi dan tekan Enter
        let agregasiSelector = "input#react-select-filter-agregasi-input";
        await inputSelectionWithEnter(driver, agregasiSelector, agregasi);

        // 3. Select Jenis HS dan tekan Enter
        let jenisHsSelector = "input#react-select-filter-jenishs-input";
        await inputSelectionWithEnter(driver, jenisHsSelector, jenisHs);

        // 4. Select Years
        await selectYears(driver, years);

    } catch (e) {
        printError(`Gagal mereset formulir dengan me-refresh halaman: ${e}`);
        throw e;
    }
}

// Main scraping function
async function scrapeBpsExim({
    jenis = 'Ekspor',
    agregasi = 'Menurut Kode HS',
    jenisHs = 'HS Full',
    years = ['2022', '2023'],
    hsCsv = 'HSCode 2017-2021.csv',
    processedHsCsv = 'ProcessedHSCodes_Export_2020',
    failedBatchLog = 'failed_batches.log',
    downloadType = 'Nilai', // Default to 'Nilai'
    headless = false,
    startIndex = 0,
    endIndex = null,
    batchSize = 20,
    downloadDir = "D:/Data HP14 Backup/3 INTERN/CESGS/9 - Scraping BPS Exim/Ekspor 2020-2021 Batch 1",
}) {
    printInfo("Memulai proses scraping...");

    // Validasi downloadType
    const validDownloadTypes = ['nilai', 'berat'];
    if (!validDownloadTypes.includes(downloadType.toLowerCase())) {
        printError(`Jenis pengunduhan '${downloadType}' tidak valid. Pilih 'Nilai' atau 'Berat'.`);
        return;
    }

    // Read processed HS codes
    let processedHsCodes = await readProcessedHsCodes(processedHsCsv);

    // Read all HS codes
    let hsCodes = await readHsCodes(hsCsv);
    let totalCodes = hsCodes.length;
    printInfo(`Total Kode HS yang tersedia: ${totalCodes}`);

    // Handle endIndex
    if (endIndex === null || endIndex >= hsCodes.length) {
        endIndex = hsCodes.length - 1;
    }

    // Validate startIndex and endIndex
    if (startIndex < 0 || startIndex >= hsCodes.length) {
        printWarning(`startIndex ${startIndex} tidak valid. Harus antara 0 dan ${hsCodes.length - 1}.`);
        return;
    }
    if (endIndex < startIndex) {
        printWarning(`endIndex ${endIndex} lebih kecil dari startIndex ${startIndex}.`);
        return;
    }

    printInfo(`Skrip akan memproses dari index ${startIndex} (${hsCodes[startIndex]}) hingga index ${endIndex} (${hsCodes[endIndex]}).`);

    // Build hsCodesToProcess by iterating over hsCodes from startIndex to endIndex
    let hsCodesToProcess = [];
    for (let i = startIndex; i <= endIndex && i < hsCodes.length; i++) {
        let hsCode = hsCodes[i];
        if (!processedHsCodes.includes(hsCode)) {
            hsCodesToProcess.push(hsCode);
        }
    }

    let totalToProcess = hsCodesToProcess.length;
    printInfo(`Total Kode HS yang akan diproses: ${totalToProcess}`);

    if (totalToProcess === 0) {
        printSuccess("Semua Kode HS dalam rentang telah diproses.");
        return;
    }

    // Get next batch number based on existing files
    let batchNumber = getNextBatchNumber(downloadDir);
    printInfo(`Memulai dengan nomor batch ${batchNumber}.`);

    // Initialize WebDriver
    let driver = await initializeDriver(headless, downloadDir);

    try {
        // 1. Open the site
        await driver.get("https://bps.go.id/exim");
        printSuccess("Berhasil membuka situs bps.go.id/exim.");

        // 2. Select Data: Ekspor or Impor
        await selectRadioButton(driver, jenis);

        // 3. Select Agregasi and press Enter
        let agregasiSelector = "input#react-select-filter-agregasi-input";
        await inputSelectionWithEnter(driver, agregasiSelector, agregasi);

        // 4. Select Jenis HS and press Enter
        let jenisHsSelector = "input#react-select-filter-jenishs-input";
        await inputSelectionWithEnter(driver, jenisHsSelector, jenisHs);

        // 5. Select Years
        await selectYears(driver, years);

        // 6. Process HS Codes in batches
        for (let i = 0; i < totalToProcess; i += batchSize) {
            let batch = hsCodesToProcess.slice(i, i + batchSize);
            let attempts = 0;
            let success = false;

            while (attempts < 3 && !success) {
                attempts++;
                printInfo(`\nMemproses Batch Kode HS dari indeks asli ${startIndex + i} hingga ${startIndex + i + batch.length - 1} (Percobaan ${attempts}): ${batch}`);

                try {
                    // Input HS Codes
                    let inputSuccess = await inputHsCodesBatch(driver, batch);
                    if (!inputSuccess) throw new Error("Gagal memasukkan Kode HS.");

                    // Click "Buat Tabel" button
                    let createTableSuccess = await clickCreateTable(driver);
                    if (!createTableSuccess) throw new Error("Gagal mengklik tombol 'Buat Tabel'.");

                    // Handle Download Type dan klik "Unduh"
                    await handleDownload(driver, downloadType, downloadDir, batchNumber);

                    // Append processed HS codes to CSV
                    appendProcessedHsCodes(processedHsCsv, batch);

                    success = true; // Batch processed successfully
                } catch (e) {
                    printError(`Kesalahan saat memproses batch: ${e}`);
                    if (attempts < 3) {
                        printInfo(`Mengulangi batch ini...`);
                        // Reset form sebelum mencoba kembali
                        await resetForm(driver, jenis, agregasi, jenisHs, years);
                    } else {
                        printError(`Batch gagal diproses setelah 3 kali percobaan.`);
                        logFailedBatch(failedBatchLog, batch, e);
                    }
                }
            }

            // Prepare for next batch
            batchNumber++; // Increment batch number
            await resetForm(driver, jenis, agregasi, jenisHs, years);
        }

        printSuccess("\nProses scraping selesai hingga end_index yang ditentukan.");

    } catch (e) {
        printError(`Terjadi kesalahan selama proses scraping: ${e}`);
    } finally {
        // Close browser after finishing
        await driver.quit();
        printInfo("Browser ditutup.");
    }
}

// Command-line argument parsing
const argv = yargs
    .option('jenis', {
        alias: 'j',
        description: "Jenis data: 'Ekspor' atau 'Impor'",
        type: 'string',
        default: 'Ekspor',
    })
    .option('agregasi', {
        alias: 'a',
        description: "Opsi agregasi",
        type: 'string',
        default: 'Menurut Kode HS',
    })
    .option('jenis_hs', {
        alias: 'hs',
        description: "Jenis HS",
        type: 'string',
        default: 'HS Full',
    })
    .option('years', {
        alias: 'y',
        description: "Daftar tahun yang ingin dipilih",
        type: 'array',
        default: ['2022', '2023'],
    })
    .option('hs_csv', {
        alias: 'csv',
        description: "Path ke file CSV yang berisi Kode HS",
        type: 'string',
        default: 'HSCode 2022.csv',
    })
    .option('processed_hs_csv', {
        alias: 'phs',
        description: "Path ke file CSV yang berisi Kode HS yang sudah diproses",
        type: 'string',
        default: 'ProcessedHSCodes_Export_2020.csv',
    })
    .option('failed_batch_log', {
        alias: 'fbl',
        description: "Path ke file log untuk batch yang gagal",
        type: 'string',
        default: 'failed_batches.log',
    })
    .option('download_type', {
        alias: 'dt',
        description: "Jenis pengunduhan: 'Nilai' atau 'Berat'",
        type: 'string',
        choices: ['Nilai', 'Berat'],
        default: 'Nilai',
    })
    .option('headless', {
        description: "Jalankan browser dalam mode headless",
        type: 'boolean',
        default: false,
    })
    .option('start_index', {
        alias: 's',
        description: "Index mulai untuk Kode HS",
        type: 'number',
        default: 0,
    })
    .option('end_index', {
        alias: 'e',
        description: "Index akhir untuk Kode HS",
        type: 'number',
    })
    .option('batch_size', {
        alias: 'b',
        description: "Ukuran batch untuk memproses Kode HS",
        type: 'number',
        default: 20,
    })
    .option('download_dir', {
        alias: 'd',
        description: "Direktori untuk menyimpan file unduhan",
        type: 'string',
        default: "D:/Data HP14 Backup/3 INTERN/CESGS/9 - Scraping BPS Exim/Ekspor 2020-2021 Batch 1",
    })
    .check((argv) => {
        if (!['Nilai', 'Berat'].includes(argv.download_type)) {
            throw new Error("Argumen '--download_type' harus 'Nilai' atau 'Berat'.");
        }
        return true;
    })
    .help('help') // Menambahkan nama opsi 'help'
    .alias('help', 'h') // Alias '-h' hanya untuk 'help'
    .argv;

// Run the script with CLI arguments
(async () => {
    await scrapeBpsExim({
        jenis: argv.jenis,
        agregasi: argv.agregasi,
        jenisHs: argv.jenis_hs,
        years: argv.years,
        hsCsv: argv.hs_csv,
        processedHsCsv: argv.processed_hs_csv,
        failedBatchLog: argv.failed_batch_log,
        downloadType: argv.download_type,
        headless: argv.headless,
        startIndex: argv.start_index,
        endIndex: argv.end_index,
        batchSize: argv.batch_size,
        downloadDir: argv.download_dir,
    });
})();
