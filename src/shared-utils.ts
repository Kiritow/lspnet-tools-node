import assert from "node:assert";
import { Address4 } from "ip-address";

// Shared Utils with lspnet-server

export function GetAllAddressFromLinkNetworkCIDR(networkCIDR: string) {
    const addr = new Address4(networkCIDR);
    assert(
        addr.subnetMask == 30,
        `Invalid LinkCIDR ${networkCIDR} with subnet mask: ${addr.subnetMask}`
    );

    const networkAddressRaw = addr.startAddress().bigInt();
    const firstAddress = Address4.fromBigInt(networkAddressRaw + 1n).addressMinusSuffix;
    const secondAddress = Address4.fromBigInt(networkAddressRaw + 2n).addressMinusSuffix;
    assert(firstAddress !== undefined, `Failed to get first address from ${networkCIDR}`);
    assert(secondAddress !== undefined, `Failed to get second address from ${networkCIDR}`);
    return [`${firstAddress}/30`, `${secondAddress}/30`];
}
