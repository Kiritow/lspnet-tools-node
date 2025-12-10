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
    const firstAddress = Address4.fromBigInt(networkAddressRaw + 1n).address;
    const secondAddress = Address4.fromBigInt(networkAddressRaw + 2n).address;
    return [`${firstAddress}/30`, `${secondAddress}/30`];
}
