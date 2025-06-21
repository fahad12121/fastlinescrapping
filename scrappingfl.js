const puppeteer = require('puppeteer');
const { redisClient3 } = require('../shared_functions');

let activeMatches = new Map();
let currentOver = 0;
let matchData = [];
let intervalId = null;
let browser = null;

const getScoreSource = async () => {
    return await redisClient3.get("score_source_fl")
}

const closeBlankPage = async (browser) => {
    let pages = await browser.pages();
    if (pages.length > 1 && (await pages[0].url()) === 'about:blank') {
        await pages[0].close();
    }
}

const stopScrapping = async (browser, page, data) => {
    await page.close();
    activeMatches.delete(data.event_id);
    const eventsStr = await getScoreSource();
    let events = JSON.parse(eventsStr);
    events = events.filter(event => event.event_id !== data.event_id);
    await redisClient3.set("score_source_fl", JSON.stringify(events));
    if (activeMatches.size == 0) {
        await browser.close();
        browser = null;
    }
}

const getEventData = async () => {
    try {
        const rawData = await getScoreSource();
        return rawData ? JSON.parse(rawData) : [];
    } catch (error) {
        console.error("Error reading match data from Redis:", error);
        return [];
    }
};

const getInningNumber = (score) => {
    const homeInning1 = score.home.inning1;
    const homeInning2 = score.home.inning2;
    const awayInning1 = score.away.inning1;
    const awayInning2 = score.away.inning2;

    const H1 = homeInning1 !== null;
    const H2 = homeInning2 !== null;
    const A1 = awayInning1 !== null;
    const A2 = awayInning2 !== null;

    const H1O = H1 ? parseFloat(homeInning1.overs) : 0;
    const H2O = H2 ? parseFloat(homeInning2?.overs || 0) : 0;
    const A1O = A1 ? parseFloat(awayInning1.overs) : 0;
    const A2O = A2 ? parseFloat(awayInning2?.overs || 0) : 0;

    if (H1 && A1 && H2 && A2) {
        if (H2O > 0 && A2O > 0) {
            return 'inning4';
        } else if (H2O > 0 || A2O > 0) {
            return 'inning3';
        } else {
            return 'inning2';
        }
    } else if ((H1 && A1 && H2 && !A2) || (H1 && A1 && !H2 && A2)) {
        return 'inning3';
    } else if (H1 && A1 && !H2 && !A2) {
        return 'inning2';
    } else if (H1 && !A1) {
        return 'inning1';
    }
}

const setAutoMarketeData = async (data) => {
    const inningKey = data.score.inningNumber;
    let overNumber = data.score.OldOvers?.split('.')[0] || '0';
    overNumber = parseInt(overNumber) + 1;
    const newScore = data.score.OldRuns;
    const inningOverKey = `${inningKey}_${overNumber}`;
    const eventScoreKey = `verify_event_scores_${data.event_nature_id}_${data.event_id}`;
    await redisClient3.hset(eventScoreKey, inningOverKey, newScore);
}

const getMatchIsOver = (text) => {
    const pattern = /won by|win by|won in|abandoned due to rain|drawn|tie/i;
    return pattern.test(text);
}

const scrapeAndExtractTextWithSVG = async (page, index, EventData, browser) => {
    console.log(index);

    if (!matchData[index]) {
        matchData[index] = { ...EventData, score: { commentary: '' } };
    }

    const extractData = async () => {
        try {

            await page.waitForSelector('.ci-team-score');

            const results = await page.$$eval('.ci-team-score', elements => {
                return elements.map(el => {
                    const team = el.querySelector('a span')?.textContent.trim() || '';

                    const oversRaw = el.querySelector('span[class*="ds-text-compact"]')?.textContent || '';
                    let overs = oversRaw.split('ov');
                    overs = overs.length > 0 ? overs[0].replace(/[^\d.]/g, '') : ''

                    const scoreStrongTags = el.querySelectorAll('strong');
                    const scores = Array.from(scoreStrongTags).map(strong => strong.textContent.trim());

                    const inning1 = scores.length > 1 ? scores[0] : null;
                    const inning2 = scores.length > 1 ? scores[1] : scores[0] || null;
                    const cleanScore = (score) => {
                        if (!score) return null;
                        score = score.replace(/&/g, '').replace(/\s+/g, '').trim();
                        return score.split('/')[0] || '0'
                    };

                    const formatInning = (runs) => runs ? { overs, runs: cleanScore(runs) } : null;

                    return {
                        team,
                        overs,
                        inning1: formatInning(inning1),
                        inning2: formatInning(inning2)
                    };
                });
            });

            let teamA = results[0];
            let teamB = results[1];

            const normalizeTeam = (team) => ({
                highlight: false,
                name: team.team || '',
                overs: team.overs || '',
                inning1: team.inning1 || team.inning2,
                inning2: team.inning1 && team.inning2 ? team.inning2 : null
            });

            let score = {
                home: normalizeTeam(teamA),
                away: normalizeTeam(teamB),
                currentTeam: '',
                currentInning: '',
                inningNumber: '',
                OldRuns: '',
                OldOvers: '',
                commentary: ''
            };
            let currentTeamKey, isAwayBatting;

            if ((score.away.inning1 && !score.home.inning2) || (score.away.inning2)) {
                currentTeamKey = "away";
                isAwayBatting = true;
            } else {
                currentTeamKey = "home";
                isAwayBatting = false;
            }

            score.home.highlight = !isAwayBatting;
            score.away.highlight = isAwayBatting;

            const currentTeam = isAwayBatting ? score.away : score.home;

            score.currentTeam = currentTeamKey;
            score.currentInning = isAwayBatting
                ? (score.away.inning2 ? "inning2" : "inning1")
                : (score.home.inning2 ? "inning2" : "inning1");

            score.OldOvers = currentTeam[score.currentInning].overs;
            score.OldRuns = currentTeam[score.currentInning].runs

            score.inningNumber = getInningNumber(score);

            matchData[index].score = score;

            let isOverEnd = score.OldOvers.split('.')[1] == 6 ? true : false

            if (isOverEnd) {
                setAutoMarketeData(matchData[index])
            }

            let commentary = '';
            const element = await page.$('.ds-text-tight-s.ds-font-medium.ds-truncate.ds-text-typo');
            if (element) {
                commentary = await page.evaluate(el => el.innerText, element);
                matchData[index].score.commentary = commentary;
            }
            console.log(JSON.stringify(matchData[index], null, 2));

            let isMatchOver = getMatchIsOver(commentary);
            if (isMatchOver) return stopScrapping(browser, page, matchData[index]);


        } catch (error) {
            return extractData();
        }
        return extractData();
    };

    await extractData();
};

(async () => {
    try {

        var proxyUrl = null;

        if (process.env.ROTATING_PROXY_ENABLE == "true") {
            proxyUrl = "http://" + process.env.ROTATING_PROXY_HOST + ":" + process.env.ROTATING_PROXY_PORT;
        }
        // const browser = await puppeteer.launch({ headless: false });
        const devtools = process.env.BROWSER_DEV_TOOLS === "true";
        let browserParams = {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                `--proxy-server=${proxyUrl}`, // Use provided proxy

                // Network and TLS options
                '--ignore-certificate-errors',
                '--ssl-version-max=tls1.3',
                '--ssl-version-min=tls1.2',

                // Reduce memory/cpu usage
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-pings',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding'
            ],
            headless: false, // Use new headless mode
            devtools: devtools, // Opens DevTools when headless is false
            ignoreHTTPSErrors: true, // Ignores HTTPS errors, useful for self-signed certificates
        }
        browser = await puppeteer.launch(browserParams);

        const startScrappingData = async (eventData) => {
            for (const [index, event] of eventData.entries()) {
                const { event_id, crickInfo_url } = event;
                if (!activeMatches.has(event_id)) {
                    (async () => {
                        activeMatches.set(event_id);

                        let page = await browser.newPage();
                        page.setCacheEnabled(false)
                        await page.setDefaultNavigationTimeout(0);

                        console.log(`Opening page ${index + 1}: ${crickInfo_url}`);

                        if (process.env.ROTATING_PROXY_USER) {
                            await page.authenticate({
                                username: process.env.ROTATING_PROXY_USER,
                                password: process.env.ROTATING_PROXY_PASSWORD,
                            });
                        }
                        try {
                            const response = await page.goto(crickInfo_url, { waitUntil: 'networkidle2', timeout: 60000 });

                            if (!response || !response.ok()) {
                                console.error(`Failed to load ${crickInfo_url}: Status ${response?.status()}`);
                                activeMatches.delete(event_id);
                                await page.close();
                            } else {
                                await closeBlankPage(browser)
                                let newEvent = {
                                    event_id: event.event_id,
                                    event_type_id: event.event_type_id,
                                    event_nature_id: event.event_nature_id,
                                }
                                console.log(`Scraping data for page ${index + 1}...`);
                                await scrapeAndExtractTextWithSVG(page, index, newEvent, browser);
                                console.log(`Finished scraping page ${index + 1}`);
                            }
                        } catch (error) {
                            console.log(error)
                            activeMatches.delete(event_id);
                            await page.close();
                        }
                    })();
                }
            }
        }

        const fetchAndProcessEvents = async () => {
            const eventData = await getEventData();
            if (!eventData.length) {
                console.error("No event data to process.");
                if (browser) await browser.close();
                return browser = null;
            }

            if (!browser) {
                browser = await puppeteer.launch(browserParams);
            }

            startScrappingData(eventData);
        }

        fetchAndProcessEvents();

        intervalId = setInterval(fetchAndProcessEvents, 15000);
    } catch (error) {
        console.log('Something went wrong, browser restarted');
    }

})();