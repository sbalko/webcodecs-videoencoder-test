const DRYRUN_NUM_FRAMES = 100;
const MAX_ENCODE_QUEUE_SIZE = 3;

function send(topic, payload) {
    self.postMessage({
        topic,
        direction: 'response',
        payload
    });
}

function log(line) {
    send('log', {severity: 'info', line});
}

function fatal(message) {
    send('error', {message});
}

function optionallyCreateCanvas(userConfig, useWebGl) {
    if (useWebGl) {
        const canvas = new OffscreenCanvas(userConfig.width, userConfig.height);
        const context = canvas.getContext('webgl2');

        return context;
    }
}

async function waitForIdle(encoder) {
    if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE_SIZE) {
        log(`Encoder queue clogged up with ${encoder.encodeQueueSize} frames, waiting to reduce to ${MAX_ENCODE_QUEUE_SIZE} or less.`);
        return new Promise(resolve => {
            encoder.ondequeue = () => {
                log(`Dequeue event received, encoder queue size is now: ${encoder.encodeQueueSize}`);
                if (encoder.encodeQueueSize <= MAX_ENCODE_QUEUE_SIZE) {
                    log(`Encoder queue size reduced to ${encoder.encodeQueueSize}, resuming.`);
                    resolve();
                }
            }
        })
    } 
}

function randomFrameData({width, height}) {
    return new Uint8Array(width * height * 12 / 8).map(() => Math.round(Math.random() * 255));
}

async function getNextFrame(frameNo, userConfig, webGlContext) {
    const duration = 1000000/userConfig.framerate;
    const timestamp = Math.ceil(frameNo * duration);

    if (webGlContext) {
        // Fill with solid, random color.
        webGlContext.viewport(0, 0, webGlContext.canvas.width, webGlContext.canvas.height);
        webGlContext.clearColor(Math.random(), Math.random(), Math.random(), 1);
        webGlContext.clear(webGlContext.COLOR_BUFFER_BIT);

        const bitmap = await createImageBitmap(webGlContext.canvas);
        return new VideoFrame(bitmap, {
            timestamp,
            duration,
            alpha: userConfig.alpha,
        });
    } else {
        // We assume a tightly packed layout, fill with white noise.
        const planes = randomFrameData(userConfig);

        return new VideoFrame(planes, {
            format: 'I420',
            codedWidth: userConfig.width,
            codedHeight: userConfig.height,
            timestamp,
            duration
        });
    }
}

async function exerciseEncoder(userConfig, userWebGl) {
    const webGlContext = optionallyCreateCanvas(userConfig, userWebGl);

    log(`Now performing dry-run of VideoEncoder API, using ${webGlContext ? 'GPU-backed' : 'in-memory'} input frames.`);

    let chunkNo = 0;

    const encoder = new VideoEncoder({
        output: chunk => {
            log(`<-- Chunk ${chunkNo++} (type ${chunk.type}) of ${chunk.byteLength} bytes at timestamp ${chunk.timestamp} micros produced.`);
        },
        error: event => {
            fatal('Error during encoder dryrun: ' + event);
        }
    });

    log(`VideoEncoder instance created, encoder status is: ${encoder.state}`);

    encoder.configure(userConfig);

    log(`VideoEncoder configured, encoder status is: ${encoder.state}`);

    for (let frameNo = 0; frameNo < DRYRUN_NUM_FRAMES; ++frameNo) {
        await waitForIdle(encoder);

        log(`Constructing ${frameNo}-th frame.`);
        const frame = await getNextFrame(frameNo, userConfig, webGlContext);

        log(`--> Passing ${frameNo}-th frame to encoder.`);
        encoder.encode(frame);

        log(`Closing ${frameNo}-th frame.`);
        frame.close();
    }

    log('Flushing encoder.')
    await encoder.flush();

    log(`Closing encoder, encoder state is: ${encoder.state}`);
    encoder.close();

    if (chunkNo === DRYRUN_NUM_FRAMES) {
        log(`All ${DRYRUN_NUM_FRAMES} frames were encoded into H.264 bitstream packages.`);
    } else {
        fatal(`Only ${chunkNo} H.264 bitstream packages were generated out of ${DRYRUN_NUM_FRAMES} frames.`);
    }

    log('Done.');
    send('done', {
        chunks: chunkNo
    })
}

async function isConfigSupported(userConfig) {
    try {
        const { supported, config } = await VideoEncoder.isConfigSupported(userConfig);

        if (supported) {
            send('done', {
                config
            });   
        } else {
            fatal('Configuration not supported');
        }
    } catch(error) {
        fatal('An error occurred when calling VideoEncoder.isConfigSupported:\n' + error);
    }
}

self.onmessage = event => {
    debugger;
    if (event.data.direction === 'request') {
        switch(event.data.topic) {
            case 'start':
                exerciseEncoder(event.data.payload.userConfig, event.data.payload.useWebGl);
                break;
            case 'support':
                isConfigSupported(event.data.payload.userConfig);
                break;
            default:
                console.error('Do not understand command', event.data);
        }
    }
};