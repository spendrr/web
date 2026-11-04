// DS-form trust anchors for the DNS root, from IANA root-anchors.xml. Two keys
// are listed on purpose: KSK-2017 is being retired by KSK-2024 (rollover in
// autumn 2026), and a proof is signed by whichever one the zone currently uses.
// 2010's key (19036) is expired and must not come back.
//
// Changing this list changes what the wallet believes about every payment
// name: take values only from https://data.iana.org/root-anchors/.
export interface TrustAnchor {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digestHex: string;
}

export const ROOT_ANCHORS: readonly TrustAnchor[] = [
  { keyTag: 20326, algorithm: 8, digestType: 2, digestHex: "e06d44b80b8f1d39a95c0b0d7c65d08458e880409bbc683457104237c7f8ec8d" },
  { keyTag: 38696, algorithm: 8, digestType: 2, digestHex: "683d2d0acb8c9b712a1948b27f741219298d0a450d612c483af444a4c0fb2b16" },
];
