import fs from 'fs';
import path from 'path';
import { create, IPFSHTTPClient } from 'ipfs-http-client';
import { ethers } from 'ethers';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { typesBundleForPolkadot } from '@crustio/type-definitions';
import { Keyring } from '@polkadot/keyring';

import { splitFile, splitFileBySize } from 'split-file';
import { env } from 'process';

const crustChainEndpoint = 'wss://rpc.crust.network'; // More endpoints: https://github.com/crustio/crust-apps/blob/master/packages/apps-config/src/endpoints/production.ts#L9
const ipfsW3GW = 'https://gw.smallwolf.me'; // More web3 authed gateways: https://github.com/crustio/ipfsscan/blob/main/lib/constans.ts#L29
var crustSeeds = 'xxx xxx xxx xxx xxx xxx xxx xxx xxx xxx xxx xxx'; // Create account(seeds): https://wiki.crust.network/docs/en/crustAccount
const api = new ApiPromise({
    provider: new WsProvider(crustChainEndpoint),
    typesBundle: typesBundleForPolkadot,
});

var wait_replica = false;
var wait_prepaid = true;
var _increment_arg_position = 0;

if (process.argv.length > 2 && process.argv[2].endsWith('index.js')) {
    _increment_arg_position = 1;
}

var filePath = process.argv[2 + _increment_arg_position];
const _seeds = process.argv[3 + _increment_arg_position];

if (_seeds) crustSeeds = _seeds;

main(filePath);


async function main(filePath: string) {
    // create output directory in same directory as input file, adding .meta.output as extension of new directory
    const outputDirectory = filePath + '.meta.output';
    const outputSplitted = filePath + '.meta.splitted.json';

    // create output directory if it does not exist
    if (!fs.existsSync(outputDirectory)) {
        fs.mkdirSync(outputDirectory);
    }


    var splitted = [];
    if (fs.existsSync(outputSplitted)) {
        splitted = JSON.parse(fs.readFileSync(outputSplitted).toString());
    } else {
        splitted = await splitFileBySize(filePath, 500000000, outputDirectory);
        fs.writeFileSync(outputSplitted, JSON.stringify(splitted));
    }

    // upload each part to IPFS and pin it
    for (var i = 0; i < splitted.length; i++) {
        var file = splitted[i];
        await uploadToIpfsAndPin(file, null, null, null, null, null);
    }

    console.log('All files uploaded to IPFS and pinned');
    process.exit(0);

}

async function uploadToIpfsAndPin(filePath: string, onUploaded: any = null, onPinned: any = null, onPrepaid: any = null, onReplica: any = null, onCompleted: any = null) {
    console.log('File Path: ', filePath);


    // I. Upload file to IPFS
    // 1. Read file
    //var filePath = '/Users/kazuo/src/lafiup-crust/sampleFile.txt';
    const fileContent = await fs.readFileSync(path.resolve(__dirname, filePath));

    // 2. [Local] Create IPFS instance
    const ipfsLocal = await create({ url: 'http://localhost:5001' });

    // 2. [Gateway] Create IPFS instance
    // Now support: ethereum-series, polkadot-series, solana, elrond, flow, near, ...
    // Let's take ethereum as example
    const pair = ethers.Wallet.createRandom();
    const sig = await pair.signMessage(pair.address);
    const authHeaderRaw = `eth-${pair.address}:${sig}`;
    const authHeader = Buffer.from(authHeaderRaw).toString('base64');
    const ipfsRemote = create({
        url: `${ipfsW3GW}/api/v0`,
        headers: {
            authorization: `Basic ${authHeader}`
        }
    });

    const ipfsMetaDataFilePath = filePath + '.meta.ipfs.json';

    // 3. Add IPFS
    var rst:any = {};
    if (fs.existsSync(ipfsMetaDataFilePath)) {
        rst = JSON.parse(fs.readFileSync(ipfsMetaDataFilePath).toString());
    } else {
        rst = await addFile(ipfsRemote, fileContent); // Or use IPFS local
    }

    console.log(rst);

    if (onUploaded) {
        onUploaded(rst)
    } else {
        fs.writeFileSync(ipfsMetaDataFilePath, JSON.stringify(rst));
    }

    // check if api is ready and wait for it
    while (!((<any>(await api.isReady))._isReady)) {
        await new Promise(f => setTimeout(f, 1000));
    }


    // II. Place storage order
    await placeStorageOrder(rst.cid, rst.size);

    if (onPinned) {
        onPinned(rst)
    }

    // III. [OPTIONAL] Add prepaid
    // Learn what's prepard for: https://wiki.crust.network/docs/en/DSM#3-file-order-assurance-settlement-and-discount
    const addedAmount = 100000000000; // in pCRU, 1 pCRU = 10^-12 CRU / 1 mCRU = 10^-6 CRU (100 mCRU is equivalent in pCRU to 100 * 10^6)
    await addPrepaid(rst.cid, addedAmount);

    // IV. Query storage status
    // Query forever here ...
    var canExit = false;
    while (true && !canExit) {
        const orderStatus: any = (await getOrderState(rst.cid)).toJSON();
        console.log('Replica count: ', orderStatus['reported_replica_count']); // Print the replica count
        console.log('Order state: ', orderStatus); // Print the order state
        await new Promise(f => setTimeout(f, 1500)); // Just wait 1.5s for next chain-query

        try {
            if (orderStatus['reported_replica_count'] > 0 || !wait_replica) {
                canExit = true;
                if (onReplica) {
                    onReplica(orderStatus)
                }
            }

            if (orderStatus['prepaid'] > 0 || !wait_prepaid) {
                canExit = true;
                if (onPrepaid) {
                    onPrepaid(orderStatus)
                }
            }
        } catch (e) {
            console.log(e);
        }

        if (canExit) {
            if (onCompleted) {
                onCompleted(rst, orderStatus);
            } else {
                const crustMetaDataFilePath = filePath + '.meta.crust.json';
                fs.writeFileSync(crustMetaDataFilePath, JSON.stringify(orderStatus));
            }
        }
    }

}

async function addFile(ipfs: IPFSHTTPClient, fileContent: any) {
    // 1. Add file to ipfs
    const cid = await ipfs.add(fileContent);

    // 2. Get file status from ipfs
    const fileStat = await ipfs.files.stat("/ipfs/" + cid.path);

    return {
        cid: cid.path,
        size: fileStat.cumulativeSize
    };
}

async function placeStorageOrder(fileCid: string, fileSize: number) {
    // 1. Construct place-storage-order tx
    const tips = 0;
    const memo = '';
    const tx = api.tx.market.placeStorageOrder(fileCid, fileSize, tips, memo);

    // 2. Load seeds(account)
    const kr = new Keyring({ type: 'sr25519' });
    const krp = kr.addFromUri(crustSeeds);

    // 3. Send transaction
    await api.isReadyOrError;
    return new Promise((resolve, reject) => {
        tx.signAndSend(krp, ({ events = [], status }) => {
            console.log(`💸  Tx status: ${status.type}, nonce: ${tx.nonce}`);

            if (status.isInBlock) {
                events.forEach(({ event: { method, section } }) => {
                    if (method === 'ExtrinsicSuccess') {
                        console.log(`✅  Place storage order success!`);
                        resolve(true);
                    }
                });
            } else {
                // Pass it
            }
        }).catch(e => {
            reject(e);
        })
    });
}

async function addPrepaid(fileCid: string, amount: number) {
    // 1. Construct add-prepaid tx
    const tx = api.tx.market.addPrepaid(fileCid, amount);

    // 2. Load seeds(account)
    const kr = new Keyring({ type: 'sr25519' });
    const krp = kr.addFromUri(crustSeeds);

    // 3. Send transaction
    await api.isReadyOrError;
    return new Promise((resolve, reject) => {
        tx.signAndSend(krp, ({ events = [], status }) => {
            console.log(`💸  Tx status: ${status.type}, nonce: ${tx.nonce}`);

            if (status.isInBlock) {
                events.forEach(({ event: { method, section } }) => {
                    if (method === 'ExtrinsicSuccess') {
                        console.log(`✅  Add prepaid success!`);
                        resolve(true);
                    }
                });
            } else {
                // Pass it
            }
        }).catch(e => {
            reject(e);
        })
    });
}

async function getOrderState(cid: string) {
    await api.isReadyOrError;
    return await api.query.market.filesV2(cid);
}