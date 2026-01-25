import assert from "node:assert";
import { parseIPAddr, parseIPAddrFromBigInt } from "./ip-addr";
// Shared Utils with lspnet-server

export function GetAllAddressFromVethLinkCIDR(networkCIDR: string) {
    const addr = parseIPAddr(networkCIDR).native;
    assert(
        addr.subnetMask == 30,
        `Invalid LinkCIDR ${networkCIDR} with subnet mask: ${addr.subnetMask}`
    );

    const networkAddressRaw = addr.startAddress().bigInt();
    const firstAddress = parseIPAddrFromBigInt(networkAddressRaw + 1n).address;
    const secondAddress = parseIPAddrFromBigInt(networkAddressRaw + 2n).address;
    return [`${firstAddress}/30`, `${secondAddress}/30`];
}
