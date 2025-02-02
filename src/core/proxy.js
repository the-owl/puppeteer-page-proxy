const CookieHandler = require("../lib/cookies");
const {setHeaders, setAgent} = require("../lib/options");
const type = require("../util/types");

// Responsible for applying proxy
const requestHandler = async (request, proxy, overrides = {}, {
    abortOnErrors,
    additionalHeaders,
    getAgent,
    gotOptions,
    timeout,
    validateResponse,
}) => {
    const { got } = await import('got');
    // Reject non http(s) URI schemes
    if (!request.url().startsWith("http") && !request.url().startsWith("https")) {
        request.continue(); return;
    }
    const cookieHandler = new CookieHandler(request);
    // Request options for Got accounting for overrides
    const options = {
        cookieJar: await cookieHandler.getCookies(),
        method: overrides.method || request.method(),
        body: overrides.postData || request.postData(),
        headers: overrides.headers || setHeaders(request, additionalHeaders),
        agent: getAgent ? getAgent(proxy) : setAgent(proxy),
        responseType: "buffer",
        maxRedirects: 15,
        throwHttpErrors: false,
        ignoreInvalidCookies: true,
        followRedirect: false,
        timeout: timeout ? {
            request: timeout
        } : null,
        ...(gotOptions || {}),
    };
    try {
        const response = await got(overrides.url || request.url(), options);
        if (validateResponse) {
            await validateResponse(response);
        }
        // Set cookies manually because "set-cookie" doesn't set all cookies (?)
        // Perhaps related to https://github.com/puppeteer/puppeteer/issues/5364
        const setCookieHeader = response.headers["set-cookie"];
        if (setCookieHeader) {
            await cookieHandler.setCookies(setCookieHeader);
            response.headers["set-cookie"] = undefined;
        }
        // correct http2 support
        if (response.headers[':status']) {
            delete response.headers[':status'];
        }
        await request.respond({
            status: response.statusCode,
            headers: response.headers,
            body: response.body
        });
    } catch (error) {
        if (abortOnErrors) {
            await request.abort();
        } else {
            throw error;
        }
    }
};

// For reassigning proxy of page
const removeRequestListener = (page, listenerName) => {
    const eventName = "request";
    const listeners = page.eventsMap.get(eventName);
    if (listeners) {
        const i = listeners.findIndex((listener) => {
            return listener.name === listenerName
        });
        listeners.splice(i, 1);
        if (!listeners.length) {
            page.eventsMap.delete(eventName);
        }
    }
};

// Calls this if request object passed
const proxyPerRequest = async (request, data, options) => {
    let proxy, overrides;
    // Separate proxy and overrides
    if (type(data) === "object") {
        if (Object.keys(data).length !== 0) {
            proxy = data.proxy;
            delete data.proxy;
            overrides = data;
        }
    } else {proxy = data}
    // Skip request if proxy omitted
    if (proxy) {await requestHandler(request, proxy, overrides, options)}
    else {request.continue(overrides)}
};

// Calls this if page object passed
const proxyPerPage = async (page, proxy, options) => {
    await page.setRequestInterception(true);
    const listener = "$ppp_request_listener";
    removeRequestListener(page, listener);
    const f = {[listener]: async (request) => {
        await requestHandler(request, proxy, {}, options);
    }};
    if (proxy) {page.on("request", f[listener])}
    else {await page.setRequestInterception(false)}
};

// Main function
const useProxy = async (target, data, options = {
    abortOnErrors: true,
    additionalHeaders: {},
    getAgent: undefined,
    gotOptions: {},
    timeout: null,
    validateResponse: null,
}) => {
    const targetType = target.constructor.name;
    if (targetType === "HTTPRequest") {
        await proxyPerRequest(target, data, options);
    } else if (targetType === "Page") {
        await proxyPerPage(target, data, options);
    }
};

module.exports = useProxy;
