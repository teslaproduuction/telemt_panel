package geoip

import (
	"net"

	"github.com/oschwald/maxminddb-golang"
)

type IPInfo struct {
	IP          string `json:"ip"`
	Country     string `json:"country"`
	CountryName string `json:"country_name"`
	City        string `json:"city"`
}

type Lookup struct {
	db *maxminddb.Reader
}

func New(dbPath string) (*Lookup, error) {
	db, err := maxminddb.Open(dbPath)
	if err != nil {
		return nil, err
	}
	return &Lookup{db: db}, nil
}

func (l *Lookup) Close() error {
	return l.db.Close()
}

type mmdbRecord struct {
	Country struct {
		ISOCode string            `maxminddb:"iso_code"`
		Names   map[string]string `maxminddb:"names"`
	} `maxminddb:"country"`
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
}

func (l *Lookup) LookupIPs(ips []string) []IPInfo {
	results := make([]IPInfo, 0, len(ips))
	for _, ipStr := range ips {
		info := IPInfo{IP: ipStr, Country: "??", CountryName: "Unknown"}

		ip := net.ParseIP(ipStr)
		if ip == nil {
			results = append(results, info)
			continue
		}

		var record mmdbRecord
		err := l.db.Lookup(ip, &record)
		if err != nil || record.Country.ISOCode == "" {
			results = append(results, info)
			continue
		}

		info.Country = record.Country.ISOCode
		if name, ok := record.Country.Names["en"]; ok {
			info.CountryName = name
		}
		if name, ok := record.City.Names["en"]; ok {
			info.City = name
		}

		results = append(results, info)
	}
	return results
}
