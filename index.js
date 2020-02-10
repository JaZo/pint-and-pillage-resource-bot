const fs = require('fs');
const https = require('https');
const yaml = require('yaml');
const axios = require('axios');
const schedule = require('node-schedule');

// The server has some SSL issues, so we disable SSL checks for now... :#
axios.defaults.httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

schedule.scheduleJob('*/15 * * * *', () => {
    (async () => {
        console.log('Transfer them resources!', new Date());

        // Parse config
        const config = yaml.parse(fs.readFileSync('./config.yml', 'utf8'));

        // Login
        const token = await axios.post('https://pintandpillage.nl/api/accounts/login', {
            username: config.username,
            password: config.password,
        }).then(response => response.data.token);

        // Create Axios instance with authorization header
        const authorizedAxios = axios.create({
            headers: {
                'Authorization': `Bearer ${token}`,
            },
        });

        // Fetch all villages
        const villages = (await Promise.all(
            (await authorizedAxios.get('https://pintandpillage.nl/api/village').then(response => response.data))
                .map(village => authorizedAxios.get(`https://pintandpillage.nl/api/village/${village.villageId}`).then(response => response.data))
        )).reduce((acc, village) => acc.set(village.name, village), new Map());

        // Check the resources
        for (const resource of config.resources) {
            // Find required villages
            if (!villages.has(resource.from)) {
                console.error(`Village ${resource.from} not found!`);
                continue;
            }
            if (!villages.has(resource.to)) {
                console.error(`Village ${resource.to} not found!`);
                continue;
            }

            const sendingVillage = villages.get(resource.from);
            const receivingVillage = villages.get(resource.to);

            // Check limit
            const limit = resource.limit < 0 ? receivingVillage.resourceLimit + resource.limit : resource.limit;
            const almostFull = receivingVillage.villageResources.availableResources[resource.type] >= limit;

            if (almostFull) {
                console.warn(`${resource.type} in ${receivingVillage.name} is over the limit (${limit}): ${receivingVillage.villageResources.availableResources[resource.type]}`);
                continue;
            }

            // Calculate the amount to send
            const threshold = resource.threshold < 0 ? sendingVillage.resourceLimit + resource.threshold : resource.threshold;
            const amountAvailable = Math.min(sendingVillage.villageResources.availableResources[resource.type] - threshold, limit - receivingVillage.villageResources.availableResources[resource.type]);
            const amountToSend = Math.floor(amountAvailable / 1000) * 1000;

            if (amountToSend > 0) {
                const market = sendingVillage.buildings.find(building => building.name === 'Market');

                if (!market) {
                    console.error(`Village ${resource.from} has no market!`);
                    continue;
                }

                // Off we go!
                await authorizedAxios.post('https://pintandpillage.nl/api/market/transfer', {
                    amount: amountToSend,
                    marketId: market.buildingId,
                    resource: resource.type,
                    toVillageId: receivingVillage.villageId,
                }).then(response => {
                    // Update our local village
                    villages.set(sendingVillage.name, response.data);

                    console.log(`Transferring ${amountToSend} ${resource.type} from ${sendingVillage.name} to ${receivingVillage.name}`);
                }, error => {
                    console.error(`Failed transferring ${amountToSend} ${resource.type} from ${sendingVillage.name} to ${receivingVillage.name}: ${error.response.data.error}`);
                });
            }
        }

        console.log('Done transferring them resources!', new Date());
    })();
});
