import { ComponentFixture, TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { AuthService } from "../../core/auth.service";
import { NormalizedListingsService } from "../../core/normalized-listings.service";
import Inbox from "./inbox";

describe("Inbox", () => {
  let component: Inbox;
  let fixture: ComponentFixture<Inbox>;

  // El constructor llama reload(), así que el servicio tiene que responder algo
  // antes de crear el componente.
  const listingsMock = {
    listNeedsReview: jasmine.createSpy("listNeedsReview").and.resolveTo({ docs: [], nextCursor: undefined }),
  };

  const authMock = {
    logout: jasmine.createSpy("logout").and.resolveTo(undefined),
  };

  const routerMock = {
    navigateByUrl: jasmine.createSpy("navigateByUrl").and.resolveTo(true),
  };

  beforeEach(async () => {
    listingsMock.listNeedsReview.calls.reset();
    authMock.logout.calls.reset();
    routerMock.navigateByUrl.calls.reset();

    await TestBed.configureTestingModule({
      imports: [Inbox],
      providers: [
        { provide: AuthService, useValue: authMock },
        { provide: Router, useValue: routerMock },
        { provide: NormalizedListingsService, useValue: listingsMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Inbox);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it("should create", () => {
    expect(component).toBeTruthy();
  });

  it("pide la primera página de pendientes al abrirse", () => {
    expect(listingsMock.listNeedsReview).toHaveBeenCalledWith(25);
  });
});
