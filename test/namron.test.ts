import {describe, expect, it, vi} from "vitest";
import {findByDevice} from "../src/index";
import {access} from "../src/lib/exposes";
import type {Definition, Expose, Fz, Tz} from "../src/lib/types";
import {mockDevice} from "./utils";

const settings = [
    {name: "ballast_minimum_level", attribute: "minLevel", value: 2},
    {name: "ballast_maximum_level", attribute: "maxLevel", value: 253},
    {name: "ballast_power_on_level", attribute: "powerOnLevel", value: 253},
] as const;

function buildDevice(modelID = "4512751", ballast = true, softwareBuildID = "3.12") {
    return mockDevice({
        modelID,
        softwareBuildID,
        manufacturerName: "NamronAS",
        endpoints: [
            {
                ID: 1,
                inputClusters: [
                    "genBasic",
                    "genIdentify",
                    "genGroups",
                    "genScenes",
                    "genOnOff",
                    "genLevelCtrl",
                    ...(ballast ? ["lightingBallastCfg"] : []),
                ],
                outputClusters: ["genOta"],
            },
        ],
    });
}

function getExposes(definition: Definition, device: ReturnType<typeof mockDevice>): Expose[] {
    return typeof definition.exposes === "function" ? definition.exposes(device, {}) : definition.exposes;
}

describe("Namron Zigbee dimmer 2.0 ballast configuration", () => {
    it.each(["4512750", "4512751"])("exposes read/write ballast settings for %s with a ballast cluster", async (modelID) => {
        const device = buildDevice(modelID);
        const definition = await findByDevice(device);
        const exposes = getExposes(definition, device);

        expect(definition.version).toBe("0.0.1");
        expect(exposes.map((expose) => expose.type)).toContain("light");
        for (const {name} of settings) {
            expect(exposes.find((expose) => expose.name === name)).toMatchObject({
                access: access.ALL,
                value_min: 1,
                value_max: 254,
                value_step: 1,
                category: "config",
            });
        }
    });

    it.each([
        {firmware: "3.09", ballast: false},
        {firmware: "3.12", ballast: false},
        {firmware: "3.13", ballast: true},
        {firmware: "", ballast: true},
    ])("gates by the advertised cluster rather than firmware '$firmware' ($ballast)", async ({firmware, ballast}) => {
        const device = buildDevice("4512751", ballast, firmware);
        const definition = await findByDevice(device);
        const exposes = getExposes(definition, device);
        for (const {name} of settings) expect(exposes.some((expose) => expose.name === name)).toBe(ballast);
    });

    it("keeps ballast exposes available for documentation generation", async () => {
        const definition = await findByDevice(buildDevice());
        expect(typeof definition.exposes).toBe("function");
        if (typeof definition.exposes !== "function") throw new Error("Expected dynamic exposes");
        const exposes = definition.exposes({isDummyDevice: true}, {});
        for (const {name} of settings) expect(exposes.some((expose) => expose.name === name)).toBe(true);
    });

    it.each([true, false])("only reads initial ballast settings when supported (%s)", async (ballast) => {
        const device = buildDevice("4512751", ballast);
        const definition = await findByDevice(device);
        const endpoint = device.getEndpoint(1);
        await definition.configure?.(device, endpoint, definition);

        const reads = endpoint.read.mock.calls.filter(([cluster]) => cluster === "lightingBallastCfg");
        expect(reads).toEqual(ballast ? [["lightingBallastCfg", ["minLevel", "maxLevel", "powerOnLevel"], {disableDefaultResponse: false}]] : []);
        expect(endpoint.write).not.toHaveBeenCalled();
        expect(endpoint.configureReporting.mock.calls.some(([cluster]) => cluster === "lightingBallastCfg")).toBe(false);
    });

    it.each(settings)("writes and reads only $attribute using default responses", async ({name, attribute, value}) => {
        const device = buildDevice();
        const definition = await findByDevice(device);
        const endpoint = device.getEndpoint(1);
        const converter = definition.toZigbee.find((candidate) => candidate.key.includes(name));
        const meta = {device, mapped: definition, message: {[name]: value}, state: {}} as Tz.Meta;

        expect(await converter.convertSet(endpoint, name, value, meta)).toEqual({state: {[name]: value}});
        expect(endpoint.write).toHaveBeenCalledExactlyOnceWith("lightingBallastCfg", {[attribute]: value}, {disableDefaultResponse: false});

        await converter.convertGet(endpoint, name, meta);
        expect(endpoint.read).toHaveBeenCalledExactlyOnceWith("lightingBallastCfg", [attribute], {disableDefaultResponse: false});
    });

    it.each([0, 255, 1.5, Number.NaN, "2"])("rejects an invalid level %s without writing", async (value) => {
        const device = buildDevice();
        const definition = await findByDevice(device);
        const endpoint = device.getEndpoint(1);
        const converter = definition.toZigbee.find((candidate) => candidate.key.includes("ballast_minimum_level"));

        await expect(converter.convertSet(endpoint, "ballast_minimum_level", value, {} as Tz.Meta)).rejects.toThrow();
        expect(endpoint.write).not.toHaveBeenCalled();
    });

    it.each(settings)("rejects manual requests for $name on unsupported firmware", async ({name, value}) => {
        const device = buildDevice("4512751", false, "3.09");
        const definition = await findByDevice(device);
        const endpoint = device.getEndpoint(1);
        const converter = definition.toZigbee.find((candidate) => candidate.key.includes(name));

        await expect(converter.convertSet(endpoint, name, value, {} as Tz.Meta)).rejects.toThrow("not supported");
        await expect(converter.convertGet(endpoint, name, {} as Tz.Meta)).rejects.toThrow("not supported");
        expect(endpoint.write).not.toHaveBeenCalled();
        expect(endpoint.read).not.toHaveBeenCalled();
    });

    it.each(settings)("decodes read responses and reports for $attribute", async ({name, attribute, value}) => {
        const device = buildDevice();
        const definition = await findByDevice(device);
        const converters = definition.fromZigbee.filter((candidate) => candidate.cluster === "lightingBallastCfg");

        for (const type of ["readResponse", "attributeReport"] as const) {
            const message = {data: {[attribute]: value}, endpoint: device.getEndpoint(1), device, type} as Fz.Message;
            const converted = Object.assign(
                {},
                ...converters.map((converter) => converter.convert(definition, message, vi.fn(), {}, {device} as Fz.Meta)),
            );
            expect(converted).toEqual({[name]: value});
        }
    });
});
