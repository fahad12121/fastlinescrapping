const puppeteer = require('puppeteer');
const { redisClient3 } = require('./shared_functions');
require('dotenv').config();
const { exec } = require('child_process');

let activeMatches = new Map();
let currentOver = 0;
let matchData = [];
let intervalId = null;

const getScoreSource = async () => {
    return await redisClient3.get("score_source_fl")
}

const setActiveScoreEventNatureIds = async (event) => {
    await redisClient3.sadd(
        "active_score_event_nature_ids",
        JSON.stringify({
            event_nature_id: event.event_nature_id,
            event_id: event.event_id,
            match_type: event.commentary_match_type,
        })
    );
}

const cleanPuppeteer = () => {
    exec('pkill -f puppeteer', (err, stdout, stderr) => {
        if (err) {
            console.error(`Puppeteer kill error: ${err.message}`);
        } else if (stderr) {
            console.error(`Puppeteer kill stderr: ${stderr}`);
        } else {
            console.log(`Puppeteer processes killed successfully:\n${stdout || 'No output'}`);
        }
    });

    exec('pkill -f chrome', (err, stdout, stderr) => {
        if (err) {
            console.error(`Chrome kill error: ${err.message}`);
        } else if (stderr) {
            console.error(`Chrome kill stderr: ${stderr}`);
        } else {
            console.log(`Chrome processes killed successfully:\n${stdout || 'No output'}`);
        }
    });
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
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }

        await browser.close();
        // cleanPuppeteer();
        process.exit(1);
    }
}

const getEventData = async () => {
    try {
        const rawData = await getScoreSource();
        if (!rawData) {
            console.log("No match data found in Redis.");
            return [];
        }
        const matchData = JSON.parse(rawData);
        console.log("Retrieved Match Data from Redis:");
        return matchData;
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
    const overNumber = data.score.OldOvers?.split('.')[0] || '0';
    const newScore = data.score.OldRuns;
    const inningOverKey = `${inningKey}_${overNumber}`;
    const eventScoreKey = `event_scores_${data.event_nature_id}_${data.event_id}`;
    await redisClient3.hset(eventScoreKey, inningOverKey, newScore);
}

const getMatchIsOver = (text) => {
    const pattern = /won by|win by|won in|abandoned due to rain|drawn|tie/i;
    return pattern.test(text);
}

const storeScoreBoard = async (data) => {
    console.log(JSON.stringify(data, null, 2));
    try {
        const key = `score_${data.event_id}`;
        const jsonData = JSON.stringify(data);
        const result = await redisClient3.set(key, jsonData);
        const wonBy = getMatchIsOver(data.score.commentary);
        if ((data.score.isOverEnd && currentOver == data.score.OldOvers.split('.')[0]) || wonBy) {
            await setAutoMarketeData(data);
        }

        if (result) {
            console.log("Data saved successfully.");
            return { success: true, message: "Data saved successfully." };
        } else {
            console.error("Failed to save data.");
            return { success: false, message: "Failed to save data." };
        }
    } catch (error) {
        console.error("Error storing match data in Redis:", error);
        return { success: false, message: "Error storing data." };
    }
};

const capitalizeFirst = (text) => {
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
};

const getFormattedCommentry = (text) => {
    const key = text.toLowerCase();
    if (key === '0') return process.env.COMMENTARY_0;
    else if (key === '1') return process.env.COMMENTARY_1;
    else if (key === '2') return process.env.COMMENTARY_2;
    else if (key === '3') return process.env.COMMENTARY_3;
    else if (key === '4') return process.env.COMMENTARY_4;
    else if (key === '5') return process.env.COMMENTARY_5;
    else if (key === '6') return process.env.COMMENTARY_6;
    else if (key === 'ball') return process.env.COMMENTARY_BALL_RUNNING;
    else if (key === 'bowler stop') return process.env.COMMENTARY_BOWLER_STOP;
    else if (key === 'over') return process.env.COMMENTARY_OVER;
    else if (key === 'wide') return process.env.COMMENTARY_WIDE;
    else if (key === 'noball') return process.env.COMMENTARY_NOBALL;
    else if (key === 'wicket') return process.env.COMMENTARY_WICKET;
    else if (key === '3rd umpire') return process.env.COMMENTARY_THIRD_UMPIRE;
    else if (key === 'inning break') return process.env.COMMENTARY_INNING_BREAK;
    else if (key === 'confirming') return process.env.COMMENTARY_COMFIRMING;

    return capitalizeFirst(text);
};

const getTargetScore = (score, target = 0, totalOverText) => {
    if (target != 0 && (score.home.inning2 || score.away.inning2)) {
        return parseInt(target) + 1;
    } else if (score.home.inning2 && score.away.inning2 && score.away.highlight) {
        return score.toWin ? (parseInt(score.away.inning2.runs) + parseInt(score.toWin)) : '';
    } else if (score.home.inning2 && score.away.inning2 && score.home.highlight) {
        return parseInt(score.away.inning2.runs) + 1;
    } else if (score.home.inning1 && score.away.highlight && totalOverText != 'TEST') {
        return parseInt(score.home.inning1.runs) + 1;
    }
    return '';
}

const scrapeAndExtractTextWithSVG = async (page, index, EventData, browser) => {
    console.log(index);

    if (!matchData[index]) {
        matchData[index] = { ...EventData, score: { commentary: '' } };
    }

    const extractData = async () => {
        try {

            const parseRunsWickets = (scoreStr) => {
                if (!scoreStr) return { runs: null, wickets: null };
                const parts = scoreStr.split('-');
                return { runs: parts[0] || null, wickets: parts[1] || null };
            };

            const parseOvers = (oversStr) => {
                if (!oversStr) return null;
                const match = oversStr.match(/([\d.]+)/);
                return match ? match[1] : null;
            };

            const getInnerText = async (element, ...childIndexes) => {
                try {
                    let el = element;
                    for (const i of childIndexes) {
                        const children = await el.$$(':scope > *');
                        if (!children[i]) return null;
                        el = children[i];
                    }
                    return await el.evaluate(node => node.innerText.trim());
                } catch {
                    return null;
                }
            };

            const getTotalOverText = (text, tOver = '0.0', isTeamB = false) => {
                if (text == 'ODI') {
                    return '50.0';
                } else if (text == 'T20') {
                    return '20.0';
                } else if (text == 'TEST') {
                    return '90.0';
                }
                return tOver;
            }
            let thisOverText = '0.0';
            let thisOverTotal = '';

            const parent = await page.$('.Livematch_main1__nVasL');
            try {
                const currentOverParent = await page.waitForSelector('.Livematch_overball__WTw9E', { timeout: 1000 });
                let currentOverElement = await page.$$('.Livematch_ov__ONQB8');
                if (currentOverElement.length >= 1) {
                    currentOverElement = await page.evaluate(el => el.innerText, currentOverElement[currentOverElement.length - 1]);
                    currentOverElement = currentOverElement.match(/\bOv\s+(\d+):/);
                    currentOver = currentOverElement ? currentOverElement[1] : '';
                }
                let currentOverScoreElement = await page.$$('.Livematch_run__9cuYC');
                if (currentOverScoreElement.length >= 1) {
                    currentOverScoreElement = await page.evaluate(el => el.innerText, currentOverScoreElement[currentOverScoreElement.length - 1]);
                    currentOverScoreElement = currentOverScoreElement.match(/=\s*(\d+)/);
                    thisOverTotal = currentOverScoreElement ? currentOverScoreElement[1] : '';
                }

                if (currentOverParent) {
                    const overDivs = await currentOverParent.$$(':scope > div');
                    if (overDivs.length > 0) {
                        const lastOverDiv = overDivs[overDivs.length - 1];
                        const ballSpans = await lastOverDiv.$$(':scope span');
                        if (ballSpans.length > 0) {
                            const ballTexts = await Promise.all(
                                ballSpans.map(span => span.evaluate(node => node.innerText.trim()))
                            );
                            thisOverText = ballTexts.join(' ');
                        }
                    }
                }

                thisOverText = thisOverText
                    .split('=')
                    .slice(-2, -1)[0]
                    .trim()
                    .split(' ')
                    .slice(1)
                    .join(' ');

            } catch (error) {
                // console.log('This over not found for now.')
            }

            const teamNameContainer = await parent.$$(':scope > div');

            let totalOverText = await getInnerText(teamNameContainer[0], 0)
            totalOverText = totalOverText.includes("Summary of") ? '' : totalOverText.replace(/\s+/g, '').split('|')[1];

            const teamAName = await getInnerText(teamNameContainer[1], 0);
            const teamBName = await getInnerText(teamNameContainer[1], 1);

            const teamScoreArea = teamNameContainer[2];
            const teamAScore = await getInnerText(teamScoreArea, 0, 1, 0);
            const teamBScore = await getInnerText(teamScoreArea, 2, 0, 0);

            const teamAOvers = await getInnerText(teamScoreArea, 0, 1, 1);
            const teamBOvers = await getInnerText(teamScoreArea, 2, 0, 1);

            let teamAInning2 = null;
            let teamBInning2 = null;


            if (totalOverText == 'TEST') {
                let teamAInning2Area = await getInnerText(teamScoreArea, 0, 1, 2);
                let teamBInning2Area = await getInnerText(teamScoreArea, 2, 0, 2);
                teamAInning2Area = teamAInning2Area.split(' ');
                teamBInning2Area = teamBInning2Area.split(' ');

                let teamAInning2Overs = teamAInning2Area[1].match(/\(([^)]+)\)/)?.[1] || '';
                let teamBInning2Overs = teamBInning2Area[1].match(/\(([^)]+)\)/)?.[1] || '';

                const teamAScoreParsed = parseRunsWickets(teamAInning2Area[0]);
                const teamBScoreParsed = parseRunsWickets(teamBInning2Area[0]);

                const teamAOversNum = parseOvers(teamAInning2Overs);
                const teamBOversNum = parseOvers(teamBInning2Overs);

                if (teamAOversNum != '0.0') teamAInning2 = { ...teamAScoreParsed, overs: teamAOversNum }
                if (teamBOversNum != '0.0') teamBInning2 = { ...teamBScoreParsed, overs: teamBOversNum }

            }

            const teamRunRateArea = teamNameContainer[4];
            const runRatesText = await getInnerText(teamRunRateArea, 1) || "";
            const runRatesParts = runRatesText.split("|");
            const currentRunRateText = runRatesParts[0]?.trim() || "CRR: 0";
            const requiredRunRateText = runRatesParts[1]?.trim() || "RR: 0";

            const toWinText = await getInnerText(teamRunRateArea, 0) || "";
            let toWin = '';
            let remainingBalls = '';
            let leadBY = '';
            const toWinMatch = toWinText.match(/(\d+).*?(\d+)/);
            if (toWinMatch && !toWinText.includes('Lead by') && !toWinText.includes('lead by') && !toWinText.includes('Trial by') && !toWinText.includes('trial by')) {
                toWin = parseInt(toWinMatch[1], 10);
                remainingBalls = parseInt(toWinMatch[2], 10);
            } else {
                if (toWinText.includes('Trial by') || toWinText.includes('trial by')) {
                    toWin = parseInt(toWinMatch[0]) + 1;
                }

                leadBY = toWinMatch ? toWinMatch[0] : '';
            }

            const teamAScoreParsed = parseRunsWickets(teamAScore);
            const teamBScoreParsed = parseRunsWickets(teamBScore);

            const teamAOversNum = parseOvers(teamAOvers);
            const teamBOversNum = parseOvers(teamBOvers);

            const currentRunRateNum = parseFloat(currentRunRateText.replace(/[^\d.]/g, "")) || 0;
            const requiredRunRateNum = parseFloat(requiredRunRateText.replace(/[^\d.]/g, "")) || 0;

            matchData[index].score = {
                home: {
                    name: teamAName || '',
                    highlight: false,
                    inning1: {
                        runs: teamAScoreParsed.runs,
                        wickets: teamAScoreParsed.wickets,
                        overs: teamAOversNum
                    },
                    inning2: teamAInning2,
                    currentRunRate: currentRunRateNum,
                    ballRemaining: remainingBalls || "",
                    toWin: toWin || ""
                },
                away: {
                    name: teamBName || '',
                    highlight: false,
                    inning1: teamBOversNum != '0.0' ? {
                        runs: teamBScoreParsed.runs,
                        wickets: teamBScoreParsed.wickets,
                        overs: teamBOversNum
                    } : null,
                    inning2: teamBInning2,
                    currentRunRate: "",
                    ballRemaining: "",
                    toWin: ""
                },
                totalOver: 0,
                thisOver: thisOverText,
                thisOverTotal: thisOverTotal,
                OldRuns: 0,
                OldOvers: 0,
                currentTeam: "",
                currentInning: "",
                inningNumber: 0,
                isOverEnd: teamAOversNum.split('.')[1] == 0 ? true : false,
                commentary: "",
                commentary_file: "",
                requiredRunRate: requiredRunRateNum,
                currentRunRate: currentRunRateNum,
                projectedScore: '',
                toWin: toWin || '',
                ballRemaining: remainingBalls || '',
                target: ''
            };

            const isTeamBOversValid = teamBOversNum !== '0.0';
            const isTeamAOversValid = teamAOversNum !== '0.0';

            const score = matchData[index].score;
            let currentTeamKey, isAwayBatting;

            if ((isTeamBOversValid && !teamAInning2) || (isTeamBOversValid && teamBInning2)) {
                if (score.away.inning2) {
                    const tempInning = score.home.inning1;
                    score.home.inning1 = score.home.inning2;
                    score.home.inning2 = tempInning;
                }
                const temp = score.home;
                score.home = score.away;
                score.away = temp;
                currentTeamKey = "away";
                isAwayBatting = true;
                score.away.currentRunRate = requiredRunRateNum;
                if (score.home.inning2) {
                    const tempInning = score.home.inning1;
                    score.home.inning1 = score.home.inning2;
                    score.home.inning2 = tempInning;
                }
            } else {
                if (score.home.inning2) {
                    const tempInning = score.home.inning1;
                    score.home.inning1 = score.home.inning2;
                    score.home.inning2 = tempInning;
                }
                currentTeamKey = "home";
                isAwayBatting = false;
            }

            score.home.highlight = !isAwayBatting;
            score.away.highlight = isAwayBatting;

            const currentTeam = isAwayBatting ? score.away : score.home;

            score.currentTeam = currentTeamKey;
            score.currentInning = isAwayBatting
                ? (teamBInning2 ? "inning2" : "inning1")
                : (teamAInning2 ? "inning2" : "inning1");

            score.OldOvers = currentTeam[score.currentInning].overs;
            score.OldRuns = currentTeam[score.currentInning].runs;

            score.totalOver = getTotalOverText(totalOverText, currentTeam[score.currentInning].overs, isAwayBatting);
            matchData[index].score = score;

            matchData[index].score.inningNumber = getInningNumber(matchData[index].score);

            matchData[index].score.target = getTargetScore(matchData[index].score, leadBY, totalOverText);

            try {
                const labels = await page.evaluate(() => {
                    const gWithLabel = document.querySelectorAll('svg g[aria-label]');
                    return Array.from(gWithLabel).map(el => el.getAttribute('aria-label'));
                });
                if (labels.length > 0) {
                    matchData[index].score.commentary = getFormattedCommentry(labels[0]);
                    await storeScoreBoard(matchData[index]);

                } else {
                    const elementText = await page.waitForSelector('.bungee-title', { timeout: 30000 })
                        .then(element => element.evaluate(el => el.innerText));

                    if (elementText) {
                        matchData[index].score.commentary = getFormattedCommentry(elementText);
                        await storeScoreBoard(matchData[index]);
                        const isMatchOver = getMatchIsOver(elementText);
                        if (isMatchOver) {
                            await stopScrapping(browser, page, matchData[index]);
                            return;
                        }
                    }
                }
            } catch (error) {
                const elementText = await page.waitForSelector('.bungee-title', { timeout: 30000 })
                    .then(element => element.evaluate(el => el.innerText));

                if (elementText) {
                    matchData[index].score.commentary = getFormattedCommentry(elementText);
                    await storeScoreBoard(matchData[index]);
                    const isMatchOver = getMatchIsOver(elementText);
                    if (isMatchOver) {
                        await stopScrapping(browser, page, matchData[index]);
                        return;
                    }
                }
                return extractData();
            }

        } catch (error) {
            return extractData();
        }
        return extractData();
    };

    await extractData();
};

(async () => {
    var proxyUrl = null;

    if (process.env.ROTATING_PROXY_ENABLE == "true") {
        proxyUrl = "http://" + process.env.ROTATING_PROXY_HOST + ":" + process.env.ROTATING_PROXY_PORT;
    }
    // const browser = await puppeteer.launch({ headless: false });
    const devtools = process.env.BROWSER_DEV_TOOLS === "true";
    const browser = await puppeteer.launch({
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
        headless: "new", // Use new headless mode
        devtools: devtools, // Opens DevTools when headless is false
        ignoreHTTPSErrors: true, // Ignores HTTPS errors, useful for self-signed certificates
    });

    const startScrappingData = async (eventData) => {
        if (!eventData.length) {
            console.error("No event data to process.");
            process.exit(1);
        }

        for (const [index, event] of eventData.entries()) {
            const { event_id, commentary_url } = event;
            if (!activeMatches.has(event_id)) {
                (async () => {
                    activeMatches.set(event_id);

                    let page = await browser.newPage();
                    page.setCacheEnabled(false)
                    await page.setDefaultNavigationTimeout(0);

                    console.log(`Opening page ${index + 1}: ${commentary_url}`);

                    if (process.env.ROTATING_PROXY_USER) {
                        await page.authenticate({
                            username: process.env.ROTATING_PROXY_USER,
                            password: process.env.ROTATING_PROXY_PASSWORD,
                        });
                    }
                    try {
                        await page.goto(commentary_url, { waitUntil: 'networkidle2', timeout: 60000 });
                        const response = await page.reload({ waitUntil: 'networkidle2' });

                        if (!response || !response.ok()) {
                            console.error(`Failed to load ${commentary_url}: Status ${response?.status()}`);
                            activeMatches.delete(event_id);
                            await page.close();
                        } else {
                            await closeBlankPage(browser)
                            let newEvent = {
                                event_id: event.event_id,
                                event_type_id: event.event_type_id,
                                event_nature_id: event.event_nature_id,
                            }
                            setActiveScoreEventNatureIds(event)
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
        startScrappingData(eventData);
    }

    fetchAndProcessEvents();

    intervalId = setInterval(fetchAndProcessEvents, 15000);

})();