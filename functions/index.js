'use strict';
const
    Promise = require('bluebird'),
    functions = require('firebase-functions'),
    admin = require('firebase-admin'),
    rp = require('request-promise-native'),
    express = require('express'),
    https = require('https'),
    httpsAgent = new https.Agent({ keepAlive: true }),

    { inspect } = require("util");

if ("FUNCTIONS_EMULATOR" in process.env) {
    const conf = {
        databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/?ns=${process.env.GCLOUD_PROJECT}`,
        credential: {
            getAccessToken: function () { return { expires_in: 123, access_token: "owner" } }
        }
    };
    console.log(`Initializing for emulator`);
    admin.initializeApp(conf);
    console.log("Loading data from ../backup.json into database");
    admin.database().ref("/").set(require("../backup.json"));
} else {
    admin.initializeApp();
}

// return string formatted as DB key
function getDbKey(t) {
    return t.replace(/[.#$/[\]]/g, '_');
}

function debug(...args) {
    //console.debug(...args); 
}

/*

updateChromebookExpirationData


*/

function getDateFromMonthYear(input) {
    var parts = input.split("(");
    return new Date("1 " + parts[0]).toISOString();
}

function getExpirationDataFromSection(html) {
    var table = html.split("<tbody>")[1].split("</tbody>")[0];
    var results = [];
    var rows = table.split("<tr>");
    rows.forEach((row) => {
        var columns = row.split("<td>").map((html) => {
            return html.replace(/(\n|<[^>]+>)/g, "");
        });
        if (columns.length < 3) {
            return;
        }
        var modelparts = columns[1].replace(/&nbsp;/g, " ").trim().split(/ \(|\/ |, |\)/g);
        var model = modelparts.shift().trim();
        var junk = modelparts.pop(); // some models have multiple submodels separated by /, sadly without system
        if (junk) {
            debug(`${columns[1]} has model ${model} and extra ${junk}, ignoring`);
        }
        var expiration = getDateFromMonthYear(columns[2].trim());
        if (modelparts.length === 0) {
            results.push([model, expiration]);
        } else {
            modelparts.forEach((submodel) => {
                results.push([model + " (" + submodel + ")", expiration]);
            });
        }

    });
    return results;
}

function getChromebookExpirationData(callback) {
    console.time('getChromebookExpirationData');
    let options = {
        uri: 'https://support.google.com/chrome/a/answer/6220366?hl=en',
        pool: httpsAgent
    }
    return rp(options).then((rawData) => {
        var sections = rawData.split('<h2 class="zippy">');
        sections.shift(); // get rid of HTML boilerplate
        var results = {};
        sections.forEach((section) => {
            var brand = section.split("</h2>")[0];
            var table = getExpirationDataFromSection(section);
            table.forEach((row) => {
                var model = row[0];
                var expiration = row[1];
                var key = getDbKey(`${brand} ${model}`);
                results[key] = {
                    brand: brand,
                    model: model,
                    expiration: expiration,
                };
            });
        });
        console.timeEnd('getChromebookExpirationData');
        return callback(results);
    }).catch((error) => {
        console.error(new Error(error));
    })
}

// getChromebookExpirationData(console.log);

function writeChromebookExpirationData(data) {
    return Promise.all([
        admin.database().ref('expiration').set(data),
        admin.database().ref('expiration_timestamp').set(new Date().toISOString())
    ]);
}

async function getChromebookData() {
    return admin.database().ref('/devices').once('value').then((snapshot) => {
        let devices = snapshot.val();
        if (!devices) {
            devices = {};
        }
        debug(devices);


        let entries = [];
        // set the id property of an entry to the key in the devices map
        Object.entries(devices).forEach(([id, entry]) => { entry.id = id; entries.push(entry) });
        debug(entries);
        return entries;
    });
}

exports.updateChromebookExpirationData = functions.pubsub.schedule('every 23 hours').onRun((context) => {
    return getChromebookExpirationData(writeChromebookExpirationData);
});


/*

updateChromebookPriceData


*/

async function getIdealoPrice(productId) {
    let options = {
        uri: `https://www.idealo.de/offerpage/pricechart/api/${productId}?period=P1M`,
        pool: httpsAgent,
        json: true
    };
    return rp(options).then((jsonData) => {
        debug(jsonData);
        var data = jsonData.data;
        var lastPrice = data.pop().y;
        debug(`Idealo ${productId} = ${lastPrice}`);
        return lastPrice;
    });
}

async function getIdealoPriceNew(productId) {
    let options = {
        uri: `https://www.idealo.de/preisvergleich/OffersOfProduct/${productId}`,
        pool: httpsAgent,
        json: false
    };
    return rp(options).then((body) => {
        let match = body.match(/<title>.*ab (.*)€.*<\/title>/);
        let price = 0;
        if (match !== null) {
            let priceString = match[1].replace(/\./g, "").replace(/,/g, ".");
            let parsedPrice = parseFloat(priceString);
            if (!isNaN(parsedPrice)) {
                price = parsedPrice;
            }
        }

        if (price > 0) {
            debug(`Idealo ${productId} = ${price}`);
        } else {
            let match = body.match(/<title>.*<\/title>/);
            console.log(`Idealo ${productId} ERROR: ${match}`)
        }

        return price;
    });
}

exports.test = functions.https.onRequest((request, response) => {
    Promise.resolve(getIdealoPrice("6950800")).then((val) => {
        console.log(val);
        return response.send(`Price: ${val}`);
    }).catch((error) => {
        if ("statusCode" in error) {
            console.error(`ERROR: Got Status Code ${error.statusCode} from ${error.options.uri}`)
        } else {
            console.error(error);
        }
    });
});

exports.test2 = functions.https.onRequest((request, response) => {
    Promise.resolve(getIdealoPrice("6943191")).then((val) => {
        console.log(val);
        return response.send(`Price: ${val}`);
    }).catch((error) => {
        if ("statusCode" in error) {
            console.error(`ERROR: Got Status Code ${error.statusCode} from ${error.options.uri}`)
        } else {
            console.error(error);
        }
    });
});

async function getMetacompPrice(productId) {
    let options = {
        uri: `https://shop.metacomp.de/Shop-DE/Produkt-1_${productId}`,
        pool: httpsAgent,
    };
    return rp(options).then((rawData) => {
        debug(rawData);
        var price = rawData.split('<span class="integerPart">')[1].split('</span>')[0];
        debug(`Metacomp ${productId} = ${price}`);
        return Number(price);
    });
}

function updateChromebookEntry(entry) {
    let id = entry.id;
    console.log(`Processing ${id}`);
    let priceFunction = undefined;
    switch (entry.productProvider) {
        case "idealo": priceFunction = getIdealoPrice; break;
        case "metacomp": priceFunction = getMetacompPrice; break;
        default: throw new Error(`PROVIDER NOT YET IMPLEMENTED: ${entry.productProvider}`);
    }
    return priceFunction(entry.productId).then((price) => {
        if (price > 0) {
            entry.price = price;
            entry.disabled = false;
            entry.priceUpdated = new Date().toISOString();
        } else {
            entry.disabled = true; // disable entry and don't change price & date
        }
        debug(entry);
        return admin.database().ref(`/devices/${id}`).set(entry);
    }).catch((error) => {
        if ("statusCode" in error) {
            console.error(`ERROR: Got Status Code ${error.statusCode} from ${error.options.uri}`)
        } else {
            console.error(error);
        }
    });

}

exports.updateChromebookPriceData = functions.pubsub.schedule('every 17 minutes').onRun((context) => {
    return Promise.map(getChromebookData(), updateChromebookEntry, { concurrency: 20 });
});

const api = express()

api.get("/api/data", (req, res) => {

    // count calls & record search string if given
    const today = new Date().toISOString().substr(0, 10);
    var statisticsTodayRef = admin.database().ref(`/statistics/${today}`);
    statisticsTodayRef.transaction((statistics) => {
        // If statistics/$today has never been set, it will be `null`.
        if (statistics && "count" in statistics) {
            statistics["count"] += 1;
        } else {
            statistics = {
                count: 1,
            }
        }
        if ("search" in req.query) {
            var search_term = req.query.search;
            if (search_term && search_term.length > 3) {
                search_term = search_term.
                    replace(/[.#$/[\]]/g, " ").
                    toLowerCase();
                if ("searches" in statistics) {
                    statistics["searches"][search_term] = search_term in statistics["searches"] ? statistics["searches"][search_term] + 1 : 1;
                } else {
                    statistics["searches"] = {};
                    statistics["searches"][search_term] = 1;
                }
            }
        }
        return statistics;
    });

    return admin.database().ref('/').once('value').then((snapshot) => {
        return res.json(snapshot.val());
    }).catch((e) => {
        console.error(e);
        return res.status(500).send("ERROR, check logs");
    });
});

api.get("*", (req, res) => {
    res.send(`<!doctype html>
    <head>
      <title>API</title>
    </head>
    <body>
      <p>API here</p>
      <pre>${inspect(req)}</pre>
    </body>
  </html>`);
});

exports.api = functions.https.onRequest(api);
