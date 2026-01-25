import assert from "node:assert";
import { Address4 } from "ip-address";

export interface AddressV4Info {
    family: "IPv4";
    address: string;
    addressCIDR: string;
    subnetMask: number;
    bign: bigint;
    native: Address4;
}

export function parseIPAddr(ipAddr: string): AddressV4Info {
    const addr = new Address4(ipAddr);
    assert(addr.isCorrect(), `Invalid IPv4 address: ${ipAddr}`);

    const trueAddress = addr.addressMinusSuffix;
    assert(trueAddress !== undefined, `Failed to parse IP address: ${ipAddr}`);

    return {
        family: "IPv4" as const,
        address: trueAddress,
        addressCIDR: `${trueAddress}/${addr.subnetMask}`,
        subnetMask: addr.subnetMask,
        bign: addr.bigInt(),
        native: addr,
    };
}

export function parseIPAddrFromBigInt(n: bigint): AddressV4Info {
    const addr = Address4.fromBigInt(n);
    assert(addr.isCorrect(), `Invalid IPv4 address from bigint: ${n}`);

    const trueAddress = addr.addressMinusSuffix;
    assert(
        trueAddress !== undefined,
        `Failed to parse IP address from bigint: ${n}`
    );
    return {
        family: "IPv4" as const,
        address: trueAddress,
        addressCIDR: `${trueAddress}/${addr.subnetMask}`,
        subnetMask: addr.subnetMask,
        bign: addr.bigInt(),
        native: addr,
    };
}
